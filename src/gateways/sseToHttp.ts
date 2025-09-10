import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  ClientCapabilities,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface SseToHttpArgs {
  sseUrl: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  headers: Record<string, string>
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

let sseClient: Client | undefined

const newInitializeSseClient = ({ message }: { message: JSONRPCRequest }) => {
  const clientInfo = message.params?.clientInfo as Implementation | undefined
  const clientCapabilities = message.params?.capabilities as
    | ClientCapabilities
    | undefined

  return new Client(
    {
      name: clientInfo?.name ?? 'supergateway',
      version: clientInfo?.version ?? getVersion(),
    },
    {
      capabilities: clientCapabilities ?? {},
    },
  )
}

export async function sseToHttp(args: SseToHttpArgs) {
  const {
    sseUrl,
    port,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    headers,
    corsOrigin,
    healthEndpoints,
  } = args

  logger.info(`  - sse: ${sseUrl}`)
  logger.info(`  - port: ${port}`)
  if (baseUrl) logger.info(`  - baseUrl: ${baseUrl}`)
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)
  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // Upstream SSE client transport (to the remote server)
  const upstreamSseTransport = new SSEClientTransport(new URL(sseUrl), {
    eventSourceInit: {
      fetch: (...props: Parameters<typeof fetch>) => {
        const [url, init = {}] = props
        return fetch(url, { ...init, headers: { ...init.headers, ...headers } })
      },
    },
    requestInit: {
      headers,
    },
  })

  upstreamSseTransport.onerror = (err) => {
    logger.error('Upstream SSE error:', err)
  }

  upstreamSseTransport.onclose = () => {
    logger.error('Upstream SSE connection closed')
  }

  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use((req, res, next) => {
    if (req.path !== messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      res.send('ok')
    })
  }

  // Track connected SSE sessions
  const sessions: Record<
    string,
    {
      transport: SSEServerTransport
      response: express.Response
    }
  > = {}

  // Broadcast upstream messages to all connected SSE sessions
  upstreamSseTransport.onmessage = (msg: JSONRPCMessage) => {
    const sessionIds = Object.keys(sessions)
    if (!sessionIds.length) return
    logger.info(
      `Upstream SSE → Clients (${sessionIds.length}): ${JSON.stringify(msg)}`,
    )
    for (const sessionId of sessionIds) {
      const session = sessions[sessionId]
      try {
        session.transport.send(msg)
      } catch (err) {
        logger.error(`Failed to send to session ${sessionId}:`, err)
      }
    }
  }

  // SSE endpoint for clients to subscribe (HTTP MCP SSE)
  app.get(ssePath, async (_req, res) => {
    logger.info(`Client subscribed to SSE at ${ssePath}`)

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )

    const sseServerTransport = new SSEServerTransport(
      `${baseUrl}${messagePath}`,
      res,
    )
    await server.connect(sseServerTransport)

    const sessionId = sseServerTransport.sessionId as string
    sessions[sessionId] = { transport: sseServerTransport, response: res }

    sseServerTransport.onclose = () => {
      logger.info(`SSE client disconnected (session ${sessionId})`)
      delete sessions[sessionId]
    }

    sseServerTransport.onerror = (err) => {
      logger.error(`SSE transport error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }

    res.on('close', () => {
      logger.info(`HTTP connection closed (session ${sessionId})`)
      delete sessions[sessionId]
    })
  })

  const wrapResponse = (req: JSONRPCRequest, payload: object) => ({
    jsonrpc: (req as any).jsonrpc || '2.0',
    id: req.id,
    ...payload,
  })

  // HTTP POST for client → upstream requests
  app.post(messagePath, async (req, res) => {
    const message = req.body as JSONRPCMessage

    const isRequest = 'method' in message && 'id' in message
    if (!isRequest) {
      logger.info('HTTP → Upstream (notification):', message)
      try {
        await sseClient?.request(message as JSONRPCRequest, z.any())
        res.status(204).end()
      } catch (err) {
        logger.error('Notification forward error:', err)
        res.status(500).json({ error: 'Notification forward error' })
      }
      return
    }

    const reqMsg = message as JSONRPCRequest
    logger.info('HTTP → Upstream (request):', reqMsg)

    try {
      if (!sseClient) {
        if (reqMsg.method === 'initialize') {
          sseClient = newInitializeSseClient({ message: reqMsg })

          const originalRequest = sseClient.request
          let initializeResult: unknown
          const boundOriginal = originalRequest.bind(sseClient)
          sseClient.request = (async (
            ...args: Parameters<typeof boundOriginal>
          ) => {
            const resReq = await boundOriginal(...args)
            initializeResult = resReq
            return resReq as any
          }) as typeof sseClient.request

          await sseClient.connect(upstreamSseTransport)
          sseClient.request = originalRequest

          // If the first request was initialize, respond with captured initializeResult
          const isOkResult =
            initializeResult != null &&
            typeof initializeResult === 'object' &&
            !('error' in (initializeResult as any))
          const payload = isOkResult
            ? { result: { ...(initializeResult as object) } }
            : {
                error: {
                  ...((initializeResult as any)?.error ?? {
                    code: -32000,
                    message: 'Internal error',
                  }),
                },
              }
          const response = wrapResponse(reqMsg, payload)
          logger.info('Response:', response)
          res.json(response)
          return
        } else {
          logger.info(
            'Upstream SSE client not initialized, creating default client',
          )
          sseClient = new Client(
            { name: 'supergateway', version: getVersion() },
            { capabilities: {} },
          )
          await sseClient.connect(upstreamSseTransport)
        }
      }

      const result = await sseClient.request(reqMsg, z.any())
      const response = wrapResponse(
        reqMsg,
        Object.prototype.hasOwnProperty.call(result, 'error')
          ? { error: { ...(result as any).error } }
          : { result: { ...result } },
      )
      logger.info('Response:', response)
      res.json(response)
    } catch (err: any) {
      logger.error('Request error:', err)
      const errorCode =
        err && typeof err === 'object' && 'code' in err
          ? (err as any).code
          : -32000
      let errorMsg =
        err && typeof err === 'object' && 'message' in err
          ? (err as any).message
          : 'Internal error'
      const prefix = `MCP error ${errorCode}:`
      if (typeof errorMsg === 'string' && errorMsg.startsWith(prefix)) {
        errorMsg = errorMsg.slice(prefix.length).trim()
      }
      const errorResp = wrapResponse(reqMsg, {
        error: {
          code: errorCode,
          message: errorMsg,
        },
      })
      res.json(errorResp)
    }
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  })
}

import net from 'node:net'

// Keep the advertised pairing endpoint local to the browser's network namespace.
const upstreamHost = process.env.ORCA_DEV_BACKEND_HOST ?? 'orca-backend-dev.orca-dev.svc.cluster.local'
const upstreamPort = 16768
const server = net.createServer((client) => {
  const upstream = net.connect({ host: upstreamHost, port: upstreamPort })
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
  client.pipe(upstream).pipe(client)
})
server.listen(16768, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

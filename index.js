import makeWASocket, { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import Anthropic from '@anthropic-ai/sdk'
import pino from 'pino'
import cron from 'node-cron'
import { Boom } from '@hapi/boom'
import { createServer } from 'http'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID
const REPORT_PHONE = process.env.REPORT_PHONE
const PHONE_NUMBER = process.env.PHONE_NUMBER
const PORT = process.env.PORT || 3000

let pairingCode = null
let estadoConexion = 'esperando'

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  const html = `<html><head><meta http-equiv="refresh" content="4"><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;margin:0}.code{font-size:48px;font-weight:bold;letter-spacing:12px;color:#25D366;background:#1a1a1a;padding:24px 40px;border-radius:16px;margin:24px 0}.status{color:#888;font-size:14px}</style></head><body>
  ${estadoConexion === 'conectado' 
    ? '<h2>✅ Conectado a WhatsApp</h2><p class="status">El agente está activo y escuchando mensajes</p>'
    : pairingCode 
      ? `<h2>Ingresa este código en WhatsApp</h2><div class="code">${pairingCode}</div><p>WhatsApp → Dispositivos vinculados → Vincular con número de teléfono</p><p class="status">El código expira en 60 segundos — esta página se actualiza sola</p>`
      : '<h2>Iniciando sistema...</h2><p class="status">Esta página se actualiza sola cada 4 segundos</p>'
  }
  </body></html>`
  res.end(html)
})

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`))

const PROMPT_SISTEMA = `Eres un agente experto en gestión de proyectos. Analiza el mensaje de WhatsApp y determina si contiene tareas, compromisos, pendientes o accionables. Si encuentras tareas, responde SOLO con JSON válido: {"hay_tareas":true,"tareas":[{"titulo":"título corto","descripcion":"detalle completo","responsable":"nombre o Sin asignar","prioridad":"urgente|alta|normal|baja","fecha_limite":"DD/MM/YYYY o null"}]}. Si NO hay tareas: {"hay_tareas":false}. Responde SOLO el JSON sin texto adicional.`

async function analizarMensaje(texto, remitente, grupo) {
  try {
    const respuesta = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: PROMPT_SISTEMA,
      messages: [{ role: 'user', content: `Grupo: ${grupo}\nRemitente: ${remitente}\nMensaje: ${texto}` }]
    })
    return JSON.parse(respuesta.content[0].text.trim())
  } catch (e) {
    console.error('Error analizando:', e.message)
    return { hay_tareas: false }
  }
}

async function crearTareaClickUp(tarea, ctx) {
  const prioridades = { urgente: 1, alta: 2, normal: 3, baja: 4 }
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
      method: 'POST',
      headers: { 'Authorization': CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tarea.titulo,
        description: `${tarea.descripcion}\n\nOrigen: ${ctx.grupo}\nRemitente: ${ctx.remitente}\nFecha: ${ctx.fecha}`,
        priority: prioridades[tarea.prioridad] || 3
      })
    })
    const data = await res.json()
    console.log(`Tarea creada: ${tarea.titulo} (${data.id})`)
  } catch (e) {
    console.error('Error en ClickUp:', e.message)
  }
}

async function obtenerTareasPendientes() {
  try {
    const res = await fetch(
      `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?statuses[]=to%20do&statuses[]=in%20progress&order_by=priority`,
      { headers: { 'Authorization': CLICKUP_TOKEN } }
    )
    const data = await res.json()
    return data.tasks || []
  } catch (e) {
    return []
  }
}

async function generarReporteDiario(sock) {
  const tareas = await obtenerTareasPendientes()
  const fecha = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  if (!tareas.length) {
    if (REPORT_PHONE) await sock.sendMessage(`${REPORT_PHONE}@s.whatsapp.net`, { text: `*Reporte diario ${fecha}*\n\nNo hay tareas pendientes.` })
    return
  }
  const labels = { 1: 'Urgente', 2: 'Alta', 3: 'Normal', 4: 'Baja' }
  const agrupadas = {}
  for (const t of tareas) {
    const p = t.assignees?.[0]?.username || 'Sin asignar'
    if (!agrupadas[p]) agrupadas[p] = []
    agrupadas[p].push(t)
  }
  let msg = `*Reporte diario*\n_${fecha}_\n*Total: ${tareas.length}*\n\n`
  for (const [persona, ts] of Object.entries(agrupadas)) {
    msg += `*${persona}*\n`
    for (const t of ts.sort((a, b) => (a.priority?.priority || 3) - (b.priority?.priority || 3))) {
      msg += `  [${labels[t.priority?.priority] || 'Normal'}] ${t.name}\n`
    }
    msg += '\n'
  }
  if (REPORT_PHONE) await sock.sendMessage(`${REPORT_PHONE}@s.whatsapp.net`, { text: msg })
}

async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (!sock.authState.creds.registered && PHONE_NUMBER && !pairingCode) {
      await new Promise(r => setTimeout(r, 5000))
      try {
        const numero = PHONE_NUMBER.replace(/[^0-9]/g, '')
        pairingCode = await sock.requestPairingCode(numero)
        estadoConexion = 'esperando_codigo'
        console.log(`Codigo generado: ${pairingCode}`)
      } catch (e) {
        console.error('Error:', e.message)
        setTimeout(conectarWhatsApp, 8000)
      }
    }

    if (connection === 'close') {
      pairingCode = null
      estadoConexion = 'esperando'
      const reconectar = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true
      if (reconectar) setTimeout(conectarWhatsApp, 5000)
    } else if (connection === 'open') {
      pairingCode = null
      estadoConexion = 'conectado'
      console.log('WhatsApp conectado exitosamente')
      cron.schedule('0 8 * * *', () => generarReporteDiario(sock), { timezone: 'America/Bogota' })
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue
      const remitente = msg.pushName || msg.key.participant || 'Desconocido'
      const grupo = msg.key.remoteJid
      const fecha = new Date(msg.messageTimestamp * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
      const m = msg.message
      const texto = m.conversation || m.extendedTextMessage?.text ||
        (m.imageMessage ? `[Imagen] ${m.imageMessage.caption || ''}` : '') ||
        (m.documentMessage ? `[Documento: ${m.documentMessage.fileName}]` : '') ||
        (m.audioMessage ? '[Audio recibido]' : '') || ''
      if (texto.length < 5) continue
      const resultado = await analizarMensaje(texto, remitente, grupo)
      if (resultado.hay_tareas && resultado.tareas?.length) {
        for (const tarea of resultado.tareas) {
          await crearTareaClickUp(tarea, { grupo, remitente, fecha })
        }
      }
    }
  })
}

conectarWhatsApp()

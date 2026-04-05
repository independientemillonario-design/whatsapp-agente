import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import Anthropic from '@anthropic-ai/sdk'
import pino from 'pino'
import cron from 'node-cron'
import { Boom } from '@hapi/boom'
import { createServer } from 'http'
import QRCode from 'qrcode'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID
const REPORT_PHONE = process.env.REPORT_PHONE
const PORT = process.env.PORT || 3000

let qrActual = null

const server = createServer(async (req, res) => {
  if (qrActual) {
    const qrImg = await QRCode.toDataURL(qrActual)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff"><h2>Escanea con WhatsApp</h2><img src="${qrImg}" style="width:300px;height:300px"/><p>Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo</p></body></html>`)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff"><h2>Conectado a WhatsApp</h2></body></html>`)
  }
})

server.listen(PORT, () => console.log(`Servidor QR en puerto ${PORT}`))

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
    console.error('Error obteniendo tareas:', e.message)
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
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      qrActual = qr
      console.log('QR generado — abre la URL del servicio para escanearlo')
    }
    if (connection === 'close') {
      qrActual = null
      const reconectar = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true
      if (reconectar) conectarWhatsApp()
    } else if (connection === 'open') {
      qrActual = null
      console.log('WhatsApp conectado')
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

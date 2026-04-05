import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
import Anthropic from '@anthropic-ai/sdk'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import cron from 'node-cron'
import { Boom } from '@hapi/boom'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID
const REPORT_PHONE = process.env.REPORT_PHONE

const PROMPT_SISTEMA = `Eres un agente experto en gestión de proyectos. Analiza el mensaje de WhatsApp que recibes y determina si contiene tareas, compromisos, pendientes o accionables.

Si encuentras tareas, responde SOLO con un JSON válido con este formato exacto:
{
  "hay_tareas": true,
  "tareas": [
    {
      "titulo": "título corto y claro de la tarea",
      "descripcion": "detalle completo de la tarea",
      "responsable": "nombre de la persona asignada o 'Sin asignar'",
      "prioridad": "urgente|alta|normal|baja",
      "fecha_limite": "DD/MM/YYYY o null si no se menciona"
    }
  ]
}

Si NO hay tareas, responde SOLO con:
{ "hay_tareas": false }

Reglas:
- Extrae TODAS las tareas aunque sean implícitas
- Infiere el responsable del contexto si no se menciona explícitamente
- Prioridad urgente: hay fecha límite próxima o palabras como "ya", "ahora", "urgente"
- Prioridad alta: palabras como "importante", "necesito", "asegúrate"
- No incluyas conversación casual sin accionables
- Responde SOLO el JSON, sin texto adicional`

async function analizarMensaje(texto, remitente, grupo) {
  try {
    const respuesta = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Grupo/Chat: ${grupo}\nRemitente: ${remitente}\nMensaje: ${texto}`
      }],
      system: PROMPT_SISTEMA
    })
    const contenido = respuesta.content[0].text.trim()
    return JSON.parse(contenido)
  } catch (e) {
    console.error('Error analizando mensaje:', e.message)
    return { hay_tareas: false }
  }
}

async function crearTareaClickUp(tarea, contexto) {
  const prioridades = { urgente: 1, alta: 2, normal: 3, baja: 4 }
  const cuerpo = {
    name: tarea.titulo,
    description: `${tarea.descripcion}\n\n---\nOrigen: ${contexto.grupo}\nRemitente: ${contexto.remitente}\nFecha: ${contexto.fecha}`,
    priority: prioridades[tarea.prioridad] || 3,
    assignees: [],
    due_date: tarea.fecha_limite ? parsearFecha(tarea.fecha_limite) : null
  }
  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
      method: 'POST',
      headers: { 'Authorization': CLICKUP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    })
    const data = await res.json()
    console.log(`✅ Tarea creada: ${tarea.titulo} (ID: ${data.id})`)
    return data
  } catch (e) {
    console.error('Error creando tarea en ClickUp:', e.message)
  }
}

function parsearFecha(fechaStr) {
  if (!fechaStr) return null
  const [dia, mes, anio] = fechaStr.split('/')
  return new Date(`${anio}-${mes}-${dia}`).getTime()
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
  console.log('📊 Generando reporte diario...')
  const tareas = await obtenerTareasPendientes()
  if (tareas.length === 0) {
    const msg = '📊 *Reporte diario*\n\n✅ No hay tareas pendientes. ¡Todo al día!'
    if (REPORT_PHONE) await sock.sendMessage(`${REPORT_PHONE}@s.whatsapp.net`, { text: msg })
    return
  }

  const prioridadLabel = { 1: '🔴 Urgente', 2: '🟠 Alta', 3: '🟡 Normal', 4: '🟢 Baja' }
  let reporte = `📊 *Reporte diario de tareas*\n_${new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_\n\n`
  reporte += `*Total pendientes: ${tareas.length}*\n\n`

  const agrupadas = {}
  for (const tarea of tareas) {
    const asignado = tarea.assignees?.[0]?.username || 'Sin asignar'
    if (!agrupadas[asignado]) agrupadas[asignado] = []
    agrupadas[asignado].push(tarea)
  }

  for (const [persona, tareasPer] of Object.entries(agrupadas)) {
    reporte += `👤 *${persona}*\n`
    const ordenadas = tareasPer.sort((a, b) => (a.priority?.priority || 3) - (b.priority?.priority || 3))
    for (const t of ordenadas) {
      const pri = prioridadLabel[t.priority?.priority] || '🟡 Normal'
      const fecha = t.due_date ? ` ·

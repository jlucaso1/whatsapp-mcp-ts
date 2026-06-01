// Triagem Diária de WhatsApp — Barbara

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "whatsapp.db");
const CONFIG_PATH = path.join(__dirname, "triagem-config.json");
const LOCK_PATH = path.join(__dirname, "triagem-ultimo-envio.txt");

// ─── Configuração ──────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Arquivo de configuração não encontrado: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

// ─── Classificação ─────────────────────────────────────────────────────────
function classificar(chat, messages, config) {
  const chatName = (chat.name || chat.jid || "").toLowerCase();
  const isGroup = chat.jid.endsWith("@g.us");
  const lastMsg = messages[0]?.content?.toLowerCase() || "";

  // URGENTE — VIPs (verificar ANTES da regra de grupo)
  const vips = (config.vips || []).map((v) => v.toLowerCase());
  if (vips.some((v) => chatName.includes(v))) {
    return { nivel: "urgente", tag: "VIP" };
  }

  // JUNK — grupos não-VIP
  if (isGroup) return { nivel: "junk", tag: "" };

  // JUNK — remetentes automáticos
  const autoSenders = config.autoSenders || [];
  if (autoSenders.some((s) => chatName.includes(s.toLowerCase()))) return { nivel: "junk", tag: "" };

  // JUNK — padrões de conteúdo
  const junkPatterns = [
    /promoção|desconto|oferta|\d+%\s*off|frete grátis/i,
    /ganhe|clique aqui|acesse agora|link na bio/i,
    /encaminhada(s)? (várias|muitas) vezes/i,
    /corrente|repasse|compartilhe/i,
    /você foi selecionado|parabéns você ganhou/i,
  ];
  if (junkPatterns.some((p) => p.test(lastMsg))) return { nivel: "junk", tag: "" };

  // URGENTE — palavras-chave de urgência no conteúdo
  const urgentPatterns = [
    /urgente|emergência|socorro|preciso de ajuda|não consigo|hospital/i,
    /prazo hoje|vence hoje|deadline|até amanhã/i,
    /ligou|chamada perdida|tentei te ligar/i,
    /grávid|gravido|to gravid/i,
    /importante!!!/i,
  ];
  if (urgentPatterns.some((p) => p.test(lastMsg))) return { nivel: "urgente", tag: "conteúdo" };

  // IMPORTANTE — perguntas, solicitações, conversas pessoais
  const importantPatterns = [
    /\?|pode me|você pode|consegue|quando|onde|como|preciso que/i,
    /reunião|confirmar|remarcar|cancelar|agendamento/i,
    /assinar|contrato|documento|proposta/i,
    /te amo|amo você|saudade/i,
    /vamos|perai|pera aí|espera/i,
  ];
  if (importantPatterns.some((p) => p.test(lastMsg))) return { nivel: "importante", tag: "" };

  return { nivel: "pode_esperar", tag: "" };
}

// ─── Formata JID como telefone legível ─────────────────────────────────────
function formatarJid(jid) {
  if (!jid) return "Desconhecido";
  const num = jid.replace(/@.+$/, "");
  if (num.startsWith("55") && num.length === 13) {
    return `+55 (${num.slice(2, 4)}) ${num.slice(4, 5)} ${num.slice(5, 9)}-${num.slice(9)}`;
  }
  if (num.startsWith("55") && num.length === 12) {
    return `+55 (${num.slice(2, 4)}) ${num.slice(4, 8)}-${num.slice(8)}`;
  }
  return `+${num}`;
}

// ─── Leitura do banco ───────────────────────────────────────────────────────
function lerMensagens24h() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Banco de dados não encontrado: ${DB_PATH}`);
  }

  const db = new DatabaseSync(DB_PATH);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const chatsComMensagens = db.prepare(`
    SELECT DISTINCT
      c.jid,
      COALESCE(c.name, ct.name, ct.notify, ct.phone_number, c.jid) as name,
      c.last_message_time,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid AND m.timestamp >= ? AND m.is_from_me = 0) as msg_count
    FROM chats c
    LEFT JOIN contacts ct ON c.jid = ct.jid
    WHERE c.jid IN (
      SELECT DISTINCT chat_jid FROM messages
      WHERE timestamp >= ? AND is_from_me = 0
    )
    ORDER BY c.last_message_time DESC
  `).all(since, since);

  const resultado = [];

  for (const chat of chatsComMensagens) {
    const messages = db.prepare(`
      SELECT content, timestamp, sender, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp >= ? AND is_from_me = 0
      ORDER BY timestamp DESC
      LIMIT 5
    `).all(chat.jid, since);

    if (messages.length > 0) {
      resultado.push({ chat, messages });
    }
  }

  db.close();
  return resultado;
}

// ─── Formatação do email ────────────────────────────────────────────────────
function formatarEmail(grupos, data) {
  const { urgente, importante, pode_esperar, junk } = grupos;

  const formatMsg = (item) => {
    const nome = item.chat.name || formatarJid(item.chat.jid);
    const ultima = item.messages[0]?.content || "";
    const preview = ultima.length > 70 ? ultima.substring(0, 70) + "..." : ultima;
    const emoji = item.chat.jid.endsWith("@g.us") ? "👥" : "👤";
    const tagStr = item.tag ? ` <span style="font-size:11px;color:#888;font-weight:normal;">(${item.tag})</span>` : "";
    const count = item.chat.msg_count || 0;
    const countStr = count > 5 ? ` <span style="font-size:11px;color:#aaa;">(${count} mensagens)</span>` : "";
    return `${emoji} <b>${nome}</b>${tagStr} — "${preview}"${countStr}`;
  };

  let html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #ee322f, #fee53a); padding: 20px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">🗓️ Triagem do WhatsApp</h1>
    <p style="color: rgba(255,255,255,0.9); margin: 5px 0 0;">${data}</p>
  </div>
  <div style="background: #f9f9f9; padding: 20px; border-radius: 0 0 10px 10px;">
`;

  if (urgente.length > 0) {
    html += `<h2 style="color: #d32f2f; margin-top: 0;">🔴 URGENTE (${urgente.length})</h2><ul style="list-style:none;padding:0;">`;
    urgente.forEach(item => {
      html += `<li style="background:white;border-left:4px solid #d32f2f;padding:10px 14px;margin:5px 0;border-radius:4px;">${formatMsg(item)}</li>`;
    });
    html += `</ul>`;
  }

  if (importante.length > 0) {
    html += `<h2 style="color: #f57c00;">🟡 IMPORTANTE (${importante.length})</h2><ul style="list-style:none;padding:0;">`;
    importante.forEach(item => {
      html += `<li style="background:white;border-left:4px solid #f57c00;padding:10px 14px;margin:5px 0;border-radius:4px;">${formatMsg(item)}</li>`;
    });
    html += `</ul>`;
  }

  if (pode_esperar.length > 0) {
    html += `<h2 style="color: #1976d2;">🔵 PODE ESPERAR (${pode_esperar.length})</h2><ul style="list-style:none;padding:0;">`;
    pode_esperar.forEach(item => {
      html += `<li style="background:white;border-left:4px solid #1976d2;padding:10px 14px;margin:5px 0;border-radius:4px;">${formatMsg(item)}</li>`;
    });
    html += `</ul>`;
  }

  if (junk.length > 0) {
    const junkNomes = junk.map(item => item.chat.name || formatarJid(item.chat.jid)).join(", ");
    html += `<p style="color:#999;font-size:12px;margin-top:20px;">⚪ <b>Junk ignorado (${junk.length}):</b> ${junkNomes}</p>`;
  }

  html += `<p style="color:#ccc;font-size:11px;margin-top:4px;">Gerado automaticamente — Claude Code + WhatsApp MCP</p>`;
  html += `</div></div>`;

  return html;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, "utf-8").trim() === hoje) {
    console.log(`⏭️ Triagem já enviada hoje (${hoje}). Pulando.`);
    process.exit(0);
  }

  console.log(`🔍 Triagem iniciada: ${agora}`);

  let itens;
  try {
    itens = lerMensagens24h();
  } catch (err) {
    console.error("❌ Erro ao ler banco:", err.message);
    process.exit(1);
  }

  console.log(`📨 ${itens.length} conversas com mensagens novas nas últimas 24h`);

  const grupos = { urgente: [], importante: [], pode_esperar: [], junk: [] };
  for (const item of itens) {
    const { nivel, tag } = classificar(item.chat, item.messages, config);
    grupos[nivel].push({ ...item, tag });
  }

  console.log(`🔴 Urgente: ${grupos.urgente.length}`);
  console.log(`🟡 Importante: ${grupos.importante.length}`);
  console.log(`🔵 Pode esperar: ${grupos.pode_esperar.length}`);
  console.log(`⚪ Junk: ${grupos.junk.length}`);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: config.emailRemetente,
      pass: config.emailAppPassword,
    },
  });

  const htmlBody = formatarEmail(grupos, agora);

  const totalAtencao = grupos.urgente.length + grupos.importante.length;
  const assunto = grupos.urgente.length > 0
    ? `🔴 ${grupos.urgente.length} urgente(s) no WhatsApp — ${agora.split(",")[0]}`
    : totalAtencao > 0
    ? `🟡 ${totalAtencao} importante(s) no WhatsApp — ${agora.split(",")[0]}`
    : `✅ Nada urgente hoje — ${agora.split(",")[0]}`;

  try {
    await transporter.sendMail({
      from: `"Triagem WPP" <${config.emailRemetente}>`,
      to: config.emailDestino,
      subject: assunto,
      html: htmlBody,
    });
    console.log(`✅ Email enviado para ${config.emailDestino}`);
    fs.writeFileSync(LOCK_PATH, hoje, "utf-8");
  } catch (err) {
    console.error("❌ Erro ao enviar email:", err.message);
    process.exit(1);
  }
}

main();

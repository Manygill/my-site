/**
 * Proposal Generation Agent
 *
 * An AI agent that takes intake data from the proposal widget and:
 *   1. Scores the lead (HIGH / MEDIUM / LOW)
 *   2. Writes a tailored proposal in Mani's voice
 *   3. Renders a branded PDF using pdf-lib
 *   4. Emails the PDF to the prospect via Resend
 *   5. Notifies Mani on Telegram with the lead score
 *
 * Architecture: LLM + tools, running in a loop until the job is done.
 * The same pattern behind Claude Code itself.
 */

require('dotenv').config();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// AGENT SYSTEM PROMPT
// Read from CLAUDE.md so the agent always has current business context.
// ─────────────────────────────────────────────────────────────────────────────

function loadSystemPrompt() {
  const claudeMdPath = path.join(__dirname, '..', 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf8')
    : '';

  return `You are Mani Govindaraju's proposal generation agent. Your job is to process an inbound lead, write a tailored proposal, and deliver it.

Here is Mani's full business context — use this to write in his voice, score the lead accurately, and tailor every proposal:

${claudeMd}

---

INSTRUCTIONS:

Use your tools in this order:
1. Call write_proposal — score the lead and write the full proposal content
2. Call send_proposal_email — render the PDF and email it to the prospect
3. If store_lead is available, call it — store the lead with score and status "proposal_sent"
4. Call notify_owner — send Mani a Telegram alert with the lead score and summary

Do not skip any tool. Do not ask for clarification. Work with what you have.

WRITING GUIDELINES:
- Write in Mani's voice: direct, warm, confident, no corporate fluff
- Be specific to the prospect's actual situation — reference what they told you
- Proposals should feel like a trusted advisor wrote them, not a template
- Plain language. No jargon. No bullet soup.
- Engagement options should match the lead score:
  * HIGH: Lead with Fractional PM or Consulting, mention Coaching as add-on
  * MEDIUM: Lead with Coaching or Workshop, mention Fractional PM as next step
  * LOW: Lead with a Workshop or initial Consulting call — keep scope small`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS
// Three tools the agent can use. Each has a name, description, and JSON schema.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: 'write_proposal',
    description: 'Score the lead and write the full proposal content in Mani\'s voice. This is the content that will be rendered into a PDF and sent to the prospect.',
    input_schema: {
      type: 'object',
      properties: {
        lead_score:    { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead quality score based on CLAUDE.md scoring rules' },
        score_reason:  { type: 'string', description: 'One sentence explaining the score' },
        client_name:   { type: 'string', description: 'Prospect name or company name' },
        proposal_title:{ type: 'string', description: 'A specific, compelling proposal title (not generic)' },
        exec_summary:  { type: 'string', description: '2-3 sentences: what you heard, what the stakes are, why you\'re the right fit' },
        situation:     { type: 'string', description: '1-2 paragraphs: what\'s happening in their world right now, from their perspective' },
        approach:      { type: 'string', description: '1-2 paragraphs: how Mani would tackle this — specific, not generic' },
        options: {
          type: 'array',
          description: '2-3 engagement options tailored to this lead',
          items: {
            type: 'object',
            properties: {
              label:      { type: 'string', description: 'Option name, e.g. "Fractional PM — 3 months"' },
              description:{ type: 'string', description: '2-3 sentences on what this option covers' },
              investment: { type: 'string', description: 'Price range or rate, e.g. "$12,000–$15,000/month"' },
              best_for:   { type: 'string', description: 'One sentence on who this option is best for' }
            },
            required: ['label', 'description', 'investment', 'best_for']
          }
        },
        next_steps: { type: 'string', description: '2-3 sentences: exactly what happens next — concrete, actionable, low-friction' }
      },
      required: ['lead_score', 'score_reason', 'client_name', 'proposal_title', 'exec_summary', 'situation', 'approach', 'options', 'next_steps']
    }
  },
  {
    name: 'send_proposal_email',
    description: 'Render the proposal as a branded PDF and email it to the prospect. Call this after write_proposal.',
    input_schema: {
      type: 'object',
      properties: {
        to_email:    { type: 'string', description: 'Prospect\'s email address' },
        client_name: { type: 'string', description: 'Prospect name or company for the email greeting' },
        proposal:    { type: 'object', description: 'The full proposal object returned by write_proposal' }
      },
      required: ['to_email', 'client_name', 'proposal']
    }
  },
  {
    name: 'notify_owner',
    description: 'Send Mani a Telegram notification with the lead score and a brief summary. Call this last.',
    input_schema: {
      type: 'object',
      properties: {
        lead_score:  { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        client_name: { type: 'string' },
        email:       { type: 'string' },
        company:     { type: 'string' },
        score_reason:{ type: 'string' },
        budget:      { type: 'string' }
      },
      required: ['lead_score', 'client_name', 'email', 'company', 'score_reason']
    }
  }
];

const STORE_LEAD_TOOL = {
  name: 'store_lead',
  description: 'Store the lead in the CRM database. Call this after write_proposal, before notify_owner. Only available when Supabase is configured.',
  input_schema: {
    type: 'object',
    properties: {
      name:      { type: 'string', description: 'Contact full name' },
      company:   { type: 'string', description: 'Company name' },
      email:     { type: 'string', description: 'Contact email address' },
      industry:  { type: 'string', description: 'Company industry or sector' },
      challenge: { type: 'string', description: 'Their main challenge in 1-2 sentences' },
      budget:    { type: 'string', description: 'Budget range mentioned, or "Not specified"' },
      score:     { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead score based on the triage rules in the system prompt' },
      status:    { type: 'string', description: 'Lead status, e.g. proposal_sent' }
    },
    required: ['name', 'company', 'email', 'score', 'status']
  }
};

function getTools() {
  const tools = [...BASE_TOOLS];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    tools.push(STORE_LEAD_TOOL);
  }
  return tools;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeForPdf
//
// pdf-lib uses WinAnsi/Latin-1 encoding by default. Characters outside this
// range (smart quotes, em dashes, bullets, emojis, any Unicode > U+00FF) will
// throw an encoding error or render as boxes. This function replaces the most
// common offenders with safe ASCII equivalents and strips the rest.
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    .replace(/[\u2018\u2019\u02BC]/g, "'")   // smart single quotes, apostrophe
    .replace(/[\u201C\u201D]/g, '"')          // smart double quotes
    .replace(/\u2014|\u2015/g, '--')          // em dash, horizontal bar
    .replace(/\u2013/g, '-')                  // en dash
    .replace(/\u2022|\u2023|\u25E6/g, '*')    // bullet variants
    .replace(/\u2026/g, '...')               // ellipsis
    .replace(/\u00A0/g, ' ')                 // non-breaking space
    .replace(/\u2019/g, "'")                 // right single quotation mark (again for safety)
    .replace(/[^\x00-\xFF]/g, '');           // strip all remaining non-Latin-1
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function wrapText(text, font, size, maxWidth) {
  const words = sanitizeForPdf(text).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function buildPdf(proposal, intakeData) {
  const pdfDoc   = await PDFDocument.create();
  const bold     = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular  = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Brand colors (matches website)
  const teal    = rgb(13/255, 148/255, 136/255);
  const dark    = rgb(15/255, 36/255, 33/255);
  const muted   = rgb(74/255, 122/255, 116/255);
  const surface = rgb(238/255, 249/255, 247/255);
  const white   = rgb(1, 1, 1);
  const border  = rgb(200/255, 232/255, 228/255);

  const W = 612, H = 792;
  const margin = 56;
  const contentW = W - margin * 2;

  // ── Helper: draw a section heading ──────────────────────────────────────
  function drawSection(page, label, y) {
    page.drawRectangle({ x: margin, y: y - 2, width: contentW, height: 22, color: surface });
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentW, y }, thickness: 1, color: border });
    page.drawText(sanitizeForPdf(label.toUpperCase()), {
      x: margin + 8, y: y + 5, size: 8, font: bold, color: teal
    });
    return y - 18;
  }

  // ── Helper: draw wrapped paragraph ──────────────────────────────────────
  function drawParagraph(page, text, x, startY, size, font, color, lineHeight) {
    const lines = wrapText(text, font, size, contentW - (x - margin));
    let y = startY;
    for (const line of lines) {
      if (y < 60) return y; // don't overflow
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
    }
    return y;
  }

  // ────────────────────────────────────────────────────────────────────────
  // PAGE 1 — COVER
  // ────────────────────────────────────────────────────────────────────────
  const cover = pdfDoc.addPage([W, H]);

  // Teal header band
  cover.drawRectangle({ x: 0, y: H - 140, width: W, height: 140, color: teal });

  // Name + tagline
  cover.drawText('Mani Govindaraju', { x: margin, y: H - 60, size: 26, font: bold, color: white });
  cover.drawText('Strategic Program Management', { x: margin, y: H - 88, size: 13, font: regular, color: rgb(0.8, 0.97, 0.95) });
  cover.drawText('mani@truvs.com  |  425-287-4853  |  truvs.com', {
    x: margin, y: H - 110, size: 10, font: regular, color: rgb(0.75, 0.95, 0.93)
  });

  // Proposal title
  const titleY = H - 200;
  const titleLines = wrapText(sanitizeForPdf(proposal.proposal_title), bold, 22, contentW);
  let ty = titleY;
  for (const line of titleLines) {
    cover.drawText(line, { x: margin, y: ty, size: 22, font: bold, color: dark });
    ty -= 30;
  }

  // Client + date
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  cover.drawText(`Prepared for: ${sanitizeForPdf(proposal.client_name)}`, {
    x: margin, y: ty - 10, size: 12, font: regular, color: muted
  });
  cover.drawText(`Date: ${dateStr}`, {
    x: margin, y: ty - 28, size: 12, font: regular, color: muted
  });

  // Teal accent bar
  cover.drawRectangle({ x: margin, y: ty - 48, width: 48, height: 3, color: teal });

  // Executive Summary
  const esY = ty - 80;
  cover.drawText('EXECUTIVE SUMMARY', { x: margin, y: esY, size: 9, font: bold, color: teal });
  const esBottom = drawParagraph(cover, proposal.exec_summary, margin, esY - 18, 11.5, regular, dark, 17);

  // Lead score badge (bottom of cover page)
  const scoreColor = proposal.lead_score === 'HIGH'
    ? rgb(5/255, 150/255, 105/255)
    : proposal.lead_score === 'MEDIUM'
    ? rgb(217/255, 119/255, 6/255)
    : rgb(107/255, 114/255, 128/255);

  cover.drawRectangle({ x: margin, y: 80, width: 120, height: 28, color: scoreColor, borderRadius: 4 });
  cover.drawText(`${proposal.lead_score} PRIORITY LEAD`, {
    x: margin + 10, y: 91, size: 9, font: bold, color: white
  });
  cover.drawText(sanitizeForPdf(`Note: ${proposal.score_reason}`), {
    x: margin + 136, y: 91, size: 8.5, font: regular, color: muted
  });

  // ────────────────────────────────────────────────────────────────────────
  // PAGE 2 — SITUATION + APPROACH + OPTIONS + NEXT STEPS
  // ────────────────────────────────────────────────────────────────────────
  const p2 = pdfDoc.addPage([W, H]);

  // Thin teal top stripe
  p2.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: teal });
  p2.drawText('Mani Govindaraju  |  Strategic Program Management', {
    x: margin, y: H - 26, size: 8.5, font: regular, color: muted
  });
  p2.drawLine({ start: { x: margin, y: H - 34 }, end: { x: W - margin, y: H - 34 }, thickness: 0.5, color: border });

  let y = H - 60;

  // Situation
  y = drawSection(p2, 'Your Situation', y);
  y = drawParagraph(p2, proposal.situation, margin + 8, y - 8, 11, regular, dark, 16);
  y -= 20;

  // Approach
  if (y > 200) {
    y = drawSection(p2, 'Proposed Approach', y);
    y = drawParagraph(p2, proposal.approach, margin + 8, y - 8, 11, regular, dark, 16);
    y -= 20;
  }

  // Engagement Options — may spill onto page 3
  let optPage = p2;
  if (y < 200) {
    optPage = pdfDoc.addPage([W, H]);
    optPage.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: teal });
    y = H - 60;
  }

  y = drawSection(optPage, 'Engagement Options', y);
  y -= 8;

  for (const opt of (proposal.options || [])) {
    if (y < 120) {
      optPage = pdfDoc.addPage([W, H]);
      optPage.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: teal });
      y = H - 60;
    }
    // Option card
    const cardH = 88;
    optPage.drawRectangle({ x: margin, y: y - cardH, width: contentW, height: cardH, color: surface, borderRadius: 4 });
    optPage.drawRectangle({ x: margin, y: y - cardH, width: 4, height: cardH, color: teal, borderRadius: 2 });

    optPage.drawText(sanitizeForPdf(opt.label), { x: margin + 14, y: y - 18, size: 12, font: bold, color: dark });
    optPage.drawText(sanitizeForPdf(opt.investment), { x: W - margin - bold.widthOfTextAtSize(sanitizeForPdf(opt.investment), 12) - 4, y: y - 18, size: 12, font: bold, color: teal });

    const descLines = wrapText(opt.description, regular, 10, contentW - 24);
    let dy = y - 34;
    for (const line of descLines.slice(0, 2)) {
      optPage.drawText(line, { x: margin + 14, y: dy, size: 10, font: regular, color: dark });
      dy -= 14;
    }
    optPage.drawText(`Best for: ${sanitizeForPdf(opt.best_for)}`, {
      x: margin + 14, y: y - cardH + 12, size: 9, font: regular, color: muted
    });

    y -= cardH + 10;
  }

  y -= 10;

  // Next Steps
  if (y < 120) {
    optPage = pdfDoc.addPage([W, H]);
    optPage.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: teal });
    y = H - 60;
  }

  y = drawSection(optPage, 'Next Steps', y);
  y = drawParagraph(optPage, proposal.next_steps, margin + 8, y - 8, 11, regular, dark, 16);
  y -= 24;

  // Footer CTA on last page
  optPage.drawRectangle({ x: margin, y: y - 48, width: contentW, height: 48, color: teal, borderRadius: 6 });
  optPage.drawText('Ready to move forward?', {
    x: margin + 20, y: y - 20, size: 12, font: bold, color: white
  });
  optPage.drawText('mani@truvs.com  |  425-287-4853', {
    x: margin + 20, y: y - 38, size: 10, font: regular, color: rgb(0.8, 0.97, 0.95)
  });

  return Buffer.from(await pdfDoc.save());
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND EMAIL via Resend
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(toEmail, clientName, pdfBuffer, proposalTitle) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY not set — skipping email'); return; }

  const pdfBase64 = pdfBuffer.toString('base64');

  const body = {
    from: 'Mani Govindaraju <onboarding@resend.dev>',
    to: [toEmail],
    subject: `Your Proposal: ${sanitizeForPdf(proposalTitle)}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;color:#0F2421">
        <div style="background:#0D9488;padding:32px 40px">
          <h1 style="color:#fff;margin:0;font-size:22px">Mani Govindaraju</h1>
          <p style="color:#CCFBF1;margin:8px 0 0;font-size:14px">Strategic Program Management</p>
        </div>
        <div style="padding:40px">
          <p style="font-size:16px">Hi ${sanitizeForPdf(clientName)},</p>
          <p>Thanks for reaching out. I've put together a proposal based on what you shared — you'll find it attached.</p>
          <p>Take a look and let me know what questions you have. The best next step is usually a 30-minute call to talk through the options and see what fits best.</p>
          <p style="margin-top:32px">
            <a href="mailto:mani@truvs.com"
               style="background:#0D9488;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600">
              Reply to Schedule a Call
            </a>
          </p>
          <p style="margin-top:40px;color:#4A7A74;font-size:14px">
            Mani Govindaraju<br>
            mani@truvs.com | 425-287-4853<br>
            truvs.com
          </p>
        </div>
      </div>`,
    attachments: [{
      filename: 'proposal.pdf',
      content: pdfBase64
    }]
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
  } else {
    console.log('Email sent to', toEmail);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TELEGRAM NOTIFICATION
// ─────────────────────────────────────────────────────────────────────────────

async function sendTelegram(data) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) { console.warn('Telegram not configured — skipping alert'); return; }

  const scoreEmoji = data.lead_score === 'HIGH' ? '🔥' : data.lead_score === 'MEDIUM' ? '⚡' : '📋';

  const message = `${scoreEmoji} *New Proposal Lead — ${data.lead_score}*

*Company:* ${data.company || 'Unknown'}
*Contact:* ${data.client_name}
*Email:* ${data.email}
*Budget:* ${data.budget || 'Not specified'}

*Score reason:* ${data.score_reason}

Proposal PDF sent to their inbox.`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
  });

  if (!res.ok) console.error('Telegram error:', await res.text());
  else console.log('Telegram alert sent');
}

// ─────────────────────────────────────────────────────────────────────────────
// STORE LEAD in Supabase
// ─────────────────────────────────────────────────────────────────────────────

async function storeLead(input) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  const row = {
    name:      input.name      || null,
    company:   input.company   || null,
    email:     input.email     || null,
    industry:  input.industry  || null,
    challenge: input.challenge || null,
    budget:    input.budget    || null,
    score:     input.score     || null,
    status:    input.status    || 'proposal_sent',
  };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey':         key,
      'Authorization':  `Bearer ${key}`,
      'Content-Type':   'application/json',
      'Prefer':         'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }

  console.log('Lead stored in Supabase:', input.email);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL EXECUTOR
// Runs the actual side-effect for each tool the agent calls.
// ─────────────────────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, context) {
  console.log(`[agent] tool: ${toolName}`);

  switch (toolName) {
    case 'write_proposal':
      // Store proposal content so later tools can reference it
      context.proposal = toolInput;
      context.leadScore = toolInput.lead_score;
      return { success: true, message: 'Proposal content written.' };

    case 'send_proposal_email': {
      const proposal = toolInput.proposal || context.proposal;
      if (!proposal) return { success: false, error: 'No proposal content available' };
      const pdfBuffer = await buildPdf(proposal, context.intakeData);
      await sendEmail(toolInput.to_email, toolInput.client_name, pdfBuffer, proposal.proposal_title);
      return { success: true, message: `PDF emailed to ${toolInput.to_email}` };
    }

    case 'store_lead':
      return storeLead(toolInput);

    case 'notify_owner':
      await sendTelegram(toolInput);
      return { success: true, message: 'Owner notified via Telegram' };

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT LOOP
//
// This is the core of the agent pattern:
//   1. Send messages + available tools to Claude
//   2. Claude decides which tool to call (or to stop)
//   3. We execute the tool and return the result
//   4. Repeat until Claude stops calling tools
//
// This is the same loop behind Claude Code, Cursor, and most AI agents.
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(intakeData) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const systemPrompt = loadSystemPrompt();
  const tools = getTools();
  const context = { intakeData, proposal: null, leadScore: null };

  const messages = [{
    role: 'user',
    content: `A new proposal request came in through the website. Process it completely — score the lead, write the proposal, send the PDF, and notify me.\n\nIntake data:\n${JSON.stringify(intakeData, null, 2)}`
  }];

  let iterations = 0;
  const maxIterations = 8; // safety cap

  while (iterations < maxIterations) {
    iterations++;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ManiG Proposal Agent'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        system: systemPrompt,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter error: ${err}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const msg    = choice?.message;

    if (!msg) throw new Error('No message in response');

    // Add assistant turn to history
    messages.push({ role: 'assistant', content: msg.content });

    // Check if done
    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      console.log('[agent] complete');
      break;
    }

    // Execute each tool call and collect results
    const toolResults = [];
    for (const toolCall of msg.tool_calls) {
      let input;
      try { input = JSON.parse(toolCall.function.arguments); }
      catch { input = {}; }

      const result = await executeTool(toolCall.function.name, input, context);
      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }

    messages.push(...toolResults);
  }

  return { leadScore: context.leadScore, iterations };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLER (called by server.js)
// ─────────────────────────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { intake_data, history } = req.body;

  console.log('\n╔══════════════════════════════════╗');
  console.log('║     PROPOSAL AGENT STARTING      ║');
  console.log('╚══════════════════════════════════╝');
  console.log('Intake:', JSON.stringify(intake_data, null, 2));

  // Respond immediately — don't block the HTTP request
  res.json({ success: true, message: 'Proposal generation started' });

  // Run agent asynchronously
  runAgent(intake_data || {}).then(result => {
    console.log(`[agent] done — lead score: ${result.leadScore}, iterations: ${result.iterations}`);
  }).catch(err => {
    console.error('[agent] error:', err.message);
  });
}

module.exports = handler;

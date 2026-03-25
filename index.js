require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const CONFIG = {
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
  META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
  META_PAGE_ID: process.env.META_PAGE_ID,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json',
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  EMAIL_TO_OWNER: process.env.EMAIL_TO_OWNER,
  EMAIL_TO_BUYER: process.env.EMAIL_TO_BUYER,
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  YOUR_PROFIT_PER_SALE: 35,
  MAX_CPP: 35,
};

const KILL_RULES = {
  minSpendToCheck: 20,
  minCTR: 1.0,
  maxCPC: 2.00,
  minATCSpend: 30,
  minPhase2ROAS: 3.0,
  killROAS: 2.0,
  killSpendThreshold: 400,
};

async function getGoogleAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CONFIG.GOOGLE_CREDENTIALS_PATH,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return auth;
}

async function readPerformanceData() {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD PERFORMANCE REPORT!A2:K500',
  });
  const rows = response.data.values || [];
  return rows.map(row => ({
    date:        row[0] || '',
    campaign:    row[1] || '',
    adSet:       row[2] || '',
    adName:      row[3] || '',
    impressions: parseFloat(row[4]) || 0,
    ctr:         parseFloat(row[5]) || 0,
    clicks:      parseFloat(row[6]) || 0,
    sales:       parseFloat(row[7]) || 0,
    roas:        parseFloat(row[8]) || 0,
    profit:      parseFloat(row[9]) || 0,
    spend:       parseFloat(row[10]) || 0,
  })).filter(r => r.adName);
}

function applyKillRules(adData) {
  return adData.map(ad => {
    let decision = 'KEEP RUNNING';
    let reason = '';

    if (ad.spend < KILL_RULES.minSpendToCheck) {
      decision = 'KEEP';
      reason = `Only $${ad.spend.toFixed(2)} spent — need $${KILL_RULES.minSpendToCheck} before judging`;
    } else if (ad.ctr < KILL_RULES.minCTR) {
      decision = 'KILL';
      reason = `CTR ${ad.ctr.toFixed(2)}% is below 1% minimum`;
    } else if (ad.clicks > 0 && (ad.spend / ad.clicks) > KILL_RULES.maxCPC) {
      decision = 'KILL';
      reason = `CPC $${(ad.spend/ad.clicks).toFixed(2)} is above $2.00 maximum`;
    } else if (ad.spend >= KILL_RULES.minATCSpend && ad.sales === 0 && ad.roas === 0) {
      decision = 'KILL';
      reason = `$${ad.spend.toFixed(2)} spent with zero sales`;
    } else if (ad.spend >= KILL_RULES.killSpendThreshold && ad.roas < KILL_RULES.killROAS && ad.roas > 0) {
      decision = 'KILL';
      reason = `ROAS ${ad.roas.toFixed(2)}x under 2x after $${ad.spend.toFixed(2)} spent`;
    } else if (ad.roas >= KILL_RULES.minPhase2ROAS && ad.spend >= 50) {
      decision = 'WINNER — PROMOTE TO PHASE 2';
      reason = `ROAS ${ad.roas.toFixed(2)}x exceeds 3x — scale to $50/day`;
    } else if (ad.roas >= KILL_RULES.killROAS && ad.roas < KILL_RULES.minPhase2ROAS && ad.spend >= 50) {
      decision = 'WATCH — ONE MORE WEEK';
      reason = `ROAS ${ad.roas.toFixed(2)}x between 2x and 3x — give it 7 more days`;
    } else {
      decision = 'KEEP RUNNING';
      reason = `CTR ${ad.ctr.toFixed(2)}% ROAS ${ad.roas.toFixed(2)}x — continue monitoring`;
    }
    return { ...ad, decision, reason };
  });
}

async function askClaude(decisions) {
  const winners = decisions.filter(d => d.decision.includes('WINNER'));
  const kills   = decisions.filter(d => d.decision === 'KILL');
  const keeps   = decisions.filter(d => d.decision === 'KEEP RUNNING');

  const prompt = `You are the creative manager for Annmichell, a Colombian shapewear brand.

This week's ad performance:
KILLS (${kills.length}): ${kills.map(d => `${d.adName}: ${d.reason}`).join(' | ') || 'None'}
WINNERS (${winners.length}): ${winners.map(d => `${d.adName}: ROAS ${d.roas.toFixed(2)}x`).join(' | ') || 'None'}
RUNNING (${keeps.length}): ${keeps.map(d => `${d.adName}: ROAS ${d.roas.toFixed(2)}x`).join(' | ') || 'None'}

Write:
1. A 3-sentence plain English summary of this week
2. Three new video ad scripts for next week for the Annmichell 8203 Ultra Secret Faja at $125. Target: Latina women 25-45 who follow Cardi B. Each script needs a hook (0-3s), body (3-30s), CTA (30-40s). Use the BBL alternative angle, secret weapon angle, or Colombian authenticity angle. Make each script different.
3. For each script suggest 2 YouTube search terms for filler clips.

Keep it simple. No markdown.`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );
  return response.data.content[0].text;
}

async function writeDecisionsToSheet(decisions) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const today = new Date().toISOString().split('T')[0];
  const rows = decisions.map(d => [
    today, d.campaign, d.adSet, d.adName,
    d.impressions, d.ctr, d.clicks, d.sales,
    d.roas, d.profit, d.spend, d.decision, d.reason,
  ]);
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD PERFORMANCE REPORT!A:A',
  });
  const nextRow = (existing.data.values || []).length + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: `AD PERFORMANCE REPORT!A${nextRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function writeScriptsToSheet(claudeOutput) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const today = new Date().toISOString().split('T')[0];
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD TEXT!A:A',
  });
  const nextRow = (existing.data.values || []).length + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: `AD TEXT!A${nextRow}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        `AUTO-GENERATED ${today}`, claudeOutput, 'ENGLISH',
        '', '8203', '', '', '', '', 'VIDEO AD',
        'PENDING', 'NOT UPLOADED', '', '', 'AI BOT',
      ]],
    },
  });
}

async function sendEmailReport(decisions, claudeOutput) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
  });

  const kills   = decisions.filter(d => d.decision === 'KILL');
  const winners = decisions.filter(d => d.decision.includes('WINNER'));
  const watches = decisions.filter(d => d.decision.includes('WATCH'));
  const keeps   = decisions.filter(d => d.decision === 'KEEP RUNNING');

  const ownerBody = `ANNMICHELL ADS WEEKLY REPORT — ${new Date().toDateString()}

${claudeOutput}

KILL THESE ADS NOW (${kills.length})
${kills.length === 0 ? 'None' : kills.map(d => `- ${d.adName}\n  REASON: ${d.reason}\n  ACTION: Meta Ads Manager > toggle OFF`).join('\n')}

WINNERS — PROMOTE TO PHASE 2 (${winners.length})
${winners.length === 0 ? 'No new winners — keep testing' : winners.map(d => `- ${d.adName} | ROAS ${d.roas.toFixed(2)}x\n  ACTION: New campaign at $50/day same ad`).join('\n')}

WATCH LIST (${watches.length})
${watches.map(d => `- ${d.adName} ROAS ${d.roas.toFixed(2)}x`).join('\n') || 'None'}

STILL RUNNING (${keeps.length})
${keeps.map(d => `- ${d.adName} ROAS ${d.roas.toFixed(2)}x`).join('\n') || 'None'}

NEW SCRIPTS: Check AD TEXT tab in Google Sheet.
PROFIT CHECK: Keep cost per purchase below $${CONFIG.MAX_CPP}`;

  const buyerBody = `ANNMICHELL ADS ACTION LIST — ${new Date().toDateString()}

STEP 1 — TURN THESE ADS OFF TODAY
${kills.length === 0 ? 'Nothing to turn off.' : kills.map(d => `- ${d.adName}`).join('\n')}

STEP 2 — PROMOTE TO PHASE 2 (new campaign at $50/day)
${winners.length === 0 ? 'No promotions this week.' : winners.map(d => `- ${d.adName}`).join('\n')}

STEP 3 — LAUNCH NEW ADS TUESDAY
Open Google Sheet > AD TEXT tab > find READY TO LAUNCH scripts
New campaign > Sales > ABO on > Campaign budget OFF
Ad set 1: Cardi B interest $10/day
Ad set 2: Nicki Minaj interest $10/day
Ad set 3: Broad $10/day
Same video in all 3. Do not touch for 7 days.

STEP 4 — UPDATE SHEET
Mark launched ads as UPLOADED with today's date.`;

  await transporter.sendMail({
    from: CONFIG.EMAIL_USER,
    to: CONFIG.EMAIL_TO_OWNER,
    subject: `Annmichell Ads Report — ${kills.length} kills · ${winners.length} winners`,
    text: ownerBody,
  });

  await transporter.sendMail({
    from: CONFIG.EMAIL_USER,
    to: CONFIG.EMAIL_TO_BUYER,
    subject: `Your Annmichell Action List — ${new Date().toDateString()}`,
    text: buyerBody,
  });

  console.log('Emails sent.');
}

async function mondayJob() {
  console.log('Monday job starting...');
  try {
    const adData    = await readPerformanceData();
    const decisions = applyKillRules(adData);
    const analysis  = await askClaude(decisions);
    await writeDecisionsToSheet(decisions);
    await writeScriptsToSheet(analysis);
    await sendEmailReport(decisions, analysis);
    console.log('Monday job complete.');
  } catch (err) {
    console.error('Monday job error:', err.message);
  }
}

cron.schedule('0 8 * * 1', mondayJob, { timezone: 'America/New_York' });
console.log('Annmichell bot running. Monday 8am ET fires the weekly report.');

require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

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

// ============================================================
// GOOGLE AUTH
// ============================================================
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

// ============================================================
// GET NEXT AD SEQUENCE NUMBER
// Reads both AD TEXT and FACEBOOK AD TEXT tabs
// finds the highest AD number across both and increments
// So if last is AD166, next batch starts at AD167
// ============================================================
async function getNextAdSequenceNumbers(count = 3) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const [adText, fbText] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'AD TEXT!A:A',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: 'FACEBOOK AD TEXT!A:A',
    }),
  ]);

  let maxNum = 0;
  const allRows = [
    ...(adText.data.values || []),
    ...(fbText.data.values || []),
  ];

  allRows.forEach(row => {
    const match = (row[0] || '').match(/AD(\d+)/i);
    if (match) {
      const num = parseInt(match[1]);
      if (num > maxNum) maxNum = num;
    }
  });

  console.log(`Current highest AD sequence: AD${maxNum}. Next batch starts at AD${maxNum + 1}`);
  return Array.from({ length: count }, (_, i) => `AD${maxNum + i + 1}`);
}

// ============================================================
// READ PERFORMANCE DATA FROM AD PERFORMANCE REPORT TAB
// ============================================================
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

// ============================================================
// READ ADS READY TO LAUNCH FROM AD TEXT TAB
// Looks for rows where:
// - Column G has a video filename (AD167.mp4)
// - Column L says READY TO LAUNCH
// ============================================================
async function readAdsReadyToLaunch() {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD TEXT!A2:O500',
  });
  const rows = response.data.values || [];
  return rows
    .map((row, index) => ({
      rowIndex:    index + 2,
      adSequence:  row[0] || '',
      script:      row[1] || '',
      language:    row[2] || 'ENGLISH',
      productLink: row[3] || 'https://annmichellstore.com/products/8203-ultra-secret-line-faja',
      productId:   row[4] || '8203',
      videoFile:   row[6] || '',
      type:        row[9] || 'VIDEO AD',
      status:      row[11] || '',
    }))
    .filter(r =>
      r.adSequence &&
      r.videoFile &&
      r.videoFile.toLowerCase().endsWith('.mp4') &&
      r.status.toUpperCase() === 'READY TO LAUNCH'
    );
}

// ============================================================
// APPLY KILL RULES
// ============================================================
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
      reason = `CPC $${(ad.spend / ad.clicks).toFixed(2)} above $2.00 maximum`;
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

// ============================================================
// ASK CLAUDE — analysis + 3 new scripts + FB ad copy
// Scripts use incremental AD numbers (AD167, AD168, AD169)
// ============================================================
async function askClaude(decisions, nextAdNumbers) {
  const winners = decisions.filter(d => d.decision.includes('WINNER'));
  const kills   = decisions.filter(d => d.decision === 'KILL');
  const keeps   = decisions.filter(d => d.decision === 'KEEP RUNNING');

  const prompt = `You are the creative manager for Annmichell, a Colombian shapewear brand.

This week's ad performance:
KILLS (${kills.length}): ${kills.map(d => `${d.adName}: ${d.reason}`).join(' | ') || 'None'}
WINNERS (${winners.length}): ${winners.map(d => `${d.adName}: ROAS ${d.roas.toFixed(2)}x`).join(' | ') || 'None'}
RUNNING (${keeps.length}): ${keeps.map(d => `${d.adName}: ROAS ${d.roas.toFixed(2)}x`).join(' | ') || 'None'}

The next 3 ad sequence numbers are: ${nextAdNumbers.join(', ')}

Write the following in plain text only. No markdown. No asterisks. No bullet points.

WEEKLY SUMMARY:
3 sentences summarizing what happened this week.

${nextAdNumbers[0]} SCRIPT:
Product: Annmichell 8203 Ultra Secret Faja $125. Audience: Latina women 25-45 who follow Cardi B.
Angle: BBL alternative (she did not get surgery she just found the right faja)
HOOK (0-3s): [write the hook]
BODY (3-30s): [write the body - features, transformation, proof]
CTA (30-40s): [write the CTA with free shipping and 30 day exchange]

${nextAdNumbers[1]} SCRIPT:
Angle: Secret weapon reveal (this is what women with that body are wearing under their clothes)
HOOK (0-3s): [write the hook]
BODY (3-30s): [write the body]
CTA (30-40s): [write the CTA]

${nextAdNumbers[2]} SCRIPT:
Angle: Colombian authenticity (this is not a cheap Amazon faja this is the real Colombian one)
HOOK (0-3s): [write the hook]
BODY (3-30s): [write the body]
CTA (30-40s): [write the CTA]

${nextAdNumbers[0]} FACEBOOK AD COPY:
Using Robert Cialdini principles of persuasion (social proof, scarcity, authority, liking):
PRIMARY TEXT: [2-3 sentences, emotional, ends with urgency]
HEADLINE: [max 6 words]
SUBHEADLINE: [max 8 words]
CTA: SHOP NOW

${nextAdNumbers[1]} FACEBOOK AD COPY:
PRIMARY TEXT: [2-3 sentences]
HEADLINE: [max 6 words]
SUBHEADLINE: [max 8 words]
CTA: SHOP NOW

${nextAdNumbers[2]} FACEBOOK AD COPY:
PRIMARY TEXT: [2-3 sentences]
HEADLINE: [max 6 words]
SUBHEADLINE: [max 8 words]
CTA: SHOP NOW`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
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

// ============================================================
// PARSE CLAUDE OUTPUT — extract scripts and ad copy
// ============================================================
function parseClaude(output, nextAdNumbers) {
  const results = nextAdNumbers.map(adNum => {
    const scriptMatch = output.match(
      new RegExp(`${adNum} SCRIPT:[\\s\\S]*?(?=HOOK[:\\s]+)([\\s\\S]*?)(?=${nextAdNumbers[nextAdNumbers.indexOf(adNum) + 1]} SCRIPT:|${nextAdNumbers[0]} FACEBOOK|$)`, 'i')
    );

    const fbMatch = output.match(
      new RegExp(`${adNum} FACEBOOK AD COPY:[\\s\\S]*?PRIMARY TEXT[:\\s]+(.*?)\\nHEADLINE[:\\s]+(.*?)\\nSUBHEADLINE[:\\s]+(.*?)\\nCTA`, 'i')
    );

    // Simpler extraction — get full block between AD numbers
    const scriptBlock = extractBlock(output, `${adNum} SCRIPT:`, nextAdNumbers.filter(n => n !== adNum));
    const fbBlock = extractBlock(output, `${adNum} FACEBOOK AD COPY:`, nextAdNumbers.filter(n => n !== adNum));

    const primaryText  = extractField(fbBlock, 'PRIMARY TEXT');
    const headline     = extractField(fbBlock, 'HEADLINE');
    const subheadline  = extractField(fbBlock, 'SUBHEADLINE');

    return {
      adNum,
      script: scriptBlock.trim() || `Script for ${adNum}`,
      primaryText: primaryText || `The Ultra Secret Faja by Annmichell. Stage 5 Colombian compression. Sculpts your waist instantly. Free US shipping. 30-day exchange.`,
      headline:    headline    || `Your body snatched in seconds`,
      subheadline: subheadline || `Stage 5 Colombian compression faja`,
    };
  });
  return results;
}

function extractBlock(text, startMarker, otherMarkers) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return '';
  let endIdx = text.length;
  otherMarkers.forEach(marker => {
    const idx = text.indexOf(marker, startIdx + startMarker.length);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  });
  return text.slice(startIdx + startMarker.length, endIdx).trim();
}

function extractField(block, fieldName) {
  const match = block.match(new RegExp(`${fieldName}[:\\s]+([^\\n]+)`, 'i'));
  return match ? match[1].trim() : '';
}

// ============================================================
// WRITE SCRIPTS TO AD TEXT TAB (incremental)
// ============================================================
async function writeScriptsToAdTextTab(parsed) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD TEXT!A:A',
  });
  let nextRow = (existing.data.values || []).length + 1;

  const rows = parsed.map(p => [
    p.adNum,             // A: AD SEQUENCE — AD167, AD168, AD169
    p.script,            // B: SCRIPT
    'ENGLISH',           // C: LANGUAGE
    'https://annmichellstore.com/products/8203-ultra-secret-line-faja', // D: PRODUCT LINK
    '8203',              // E: PRODUCT ID
    '',                  // F: empty
    `${p.adNum}.mp4`,   // G: VIDEO FILE — creator names file AD167.mp4
    '',                  // H: UGC AD
    '',                  // I: UGC DOC
    'VIDEO AD',          // J: TYPE OF AD
    'PENDING APPROVAL',  // K: APROBACION
    'NOT UPLOADED',      // L: UPLOAD STATUS
    '',                  // M
    '',                  // N
    'AI BOT',            // O: USER
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: `AD TEXT!A${nextRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  console.log(`Scripts written to AD TEXT: ${parsed.map(p => p.adNum).join(', ')} starting at row ${nextRow}`);
}

// ============================================================
// WRITE FB AD COPY TO FACEBOOK AD TEXT TAB (incremental)
// Same AD number as AD TEXT tab
// ============================================================
async function writeFacebookAdCopy(parsed) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'FACEBOOK AD TEXT!A:A',
  });
  let nextRow = (existing.data.values || []).length + 1;

  const rows = parsed.map(p => [
    p.adNum,            // A: AD SEQUENCE — matches AD TEXT tab
    '8203',             // B: PRODUCT
    p.primaryText,      // C: Primary text
    p.headline,         // D: Headline
    p.subheadline,      // E: Subheadline
    'SHOP NOW',         // F: CTA
    `${p.adNum}.mp4`,  // G: Creative
    'VIDEO AD',         // H: AD CREATIVE TYPE
    'PHASE 1 ABO',      // I: CAMPAIGN TYPE
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: `FACEBOOK AD TEXT!A${nextRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  console.log(`FB ad copy written: ${parsed.map(p => p.adNum).join(', ')} starting at row ${nextRow}`);
}

// ============================================================
// WRITE DECISIONS TO AD PERFORMANCE REPORT TAB
// ============================================================
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
  console.log('Decisions written to AD PERFORMANCE REPORT');
}

// ============================================================
// MARK AD AS UPLOADED IN AD TEXT TAB
// ============================================================
async function markAdAsUploaded(adSequence) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'AD TEXT!A:A',
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(row => row[0] === adSequence);
  if (rowIndex === -1) { console.log(`${adSequence} not found in sheet`); return; }
  const today = new Date().toISOString().split('T')[0];
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: `AD TEXT!L${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[`UPLOADED ${today}`]] },
  });
  console.log(`Marked ${adSequence} as UPLOADED in sheet`);
}

// ============================================================
// DOWNLOAD VIDEO FROM GOOGLE DRIVE
// File must be named AD167.mp4 exactly
// ============================================================
async function getVideoFromDrive(videoFileName) {
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  const search = await drive.files.list({
    q: `name='${videoFileName}' and '${CONFIG.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType)',
  });

  if (!search.data.files || search.data.files.length === 0) {
    throw new Error(`Video "${videoFileName}" not found in Google Drive folder. Creator must upload file named exactly ${videoFileName}`);
  }

  const file = search.data.files[0];
  const destPath = path.join('/tmp', videoFileName);
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId: file.id, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    res.data.on('end', () => { console.log(`Downloaded ${videoFileName}`); resolve(destPath); })
           .on('error', reject)
           .pipe(dest);
  });
}

// ============================================================
// UPLOAD VIDEO TO META
// ============================================================
async function uploadVideoToMeta(videoPath, adSequence) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('name', adSequence);
  form.append('source', fs.createReadStream(videoPath));

  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_AD_ACCOUNT_ID}/advideos`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  console.log(`Uploaded ${adSequence} to Meta. Video ID: ${response.data.id}`);
  return response.data.id;
}

// ============================================================
// GET AD COPY FROM FACEBOOK AD TEXT TAB FOR THIS AD SEQUENCE
// ============================================================
async function getAdCopyFromSheet(adSequence) {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
    range: 'FACEBOOK AD TEXT!A:I',
  });
  const rows = response.data.values || [];
  const row = rows.find(r => r[0] === adSequence);
  return {
    primaryText:  row ? row[2] : 'The Ultra Secret Faja by Annmichell. Stage 5 Colombian compression. Free US shipping.',
    headline:     row ? row[3] : 'Your body snatched instantly',
    subheadline:  row ? row[4] : 'Stage 5 Colombian compression faja',
    productLink:  'https://annmichellstore.com/products/8203-ultra-secret-line-faja',
  };
}

// ============================================================
// CREATE META AD CREATIVE
// Pulls copy from FACEBOOK AD TEXT tab for matching AD sequence
// ============================================================
async function createAdCreative(videoId, adSequence) {
  const copy = await getAdCopyFromSheet(adSequence);

  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_AD_ACCOUNT_ID}/adcreatives`,
    {
      name: `Creative — ${adSequence}`,
      object_story_spec: {
        page_id: CONFIG.META_PAGE_ID,
        video_data: {
          video_id: videoId,
          message: copy.primaryText,
          title: copy.headline,
          call_to_action: {
            type: 'SHOP_NOW',
            value: { link: copy.productLink },
          },
        },
      },
      access_token: CONFIG.META_ACCESS_TOKEN,
    }
  );
  console.log(`Created ad creative for ${adSequence}`);
  return res.data.id;
}

// ============================================================
// CREATE CAMPAIGN
// ============================================================
async function createCampaign(adSequence) {
  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_AD_ACCOUNT_ID}/campaigns`,
    {
      name: `Phase 1 — ${adSequence} — ${new Date().toISOString().split('T')[0]}`,
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
      special_ad_categories: [],
      access_token: CONFIG.META_ACCESS_TOKEN,
    }
  );
  return res.data.id;
}

// ============================================================
// CREATE AD SET
// ============================================================
async function createAdSet(campaignId, audienceName, interests, adSequence) {
  const targeting = {
    geo_locations: { countries: ['US'] },
    age_min: 25,
    age_max: 45,
    genders: [2],
  };
  if (interests && interests.length > 0) {
    targeting.flexible_spec = [{ interests }];
  }
  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_AD_ACCOUNT_ID}/adsets`,
    {
      name: `${adSequence} — ${audienceName}`,
      campaign_id: campaignId,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: 1000,
      status: 'PAUSED',
      targeting,
      access_token: CONFIG.META_ACCESS_TOKEN,
    }
  );
  return res.data.id;
}

// ============================================================
// CREATE AD
// ============================================================
async function createAd(adSetId, creativeId, adSequence, audienceName) {
  const res = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_AD_ACCOUNT_ID}/ads`,
    {
      name: `${adSequence} — ${audienceName}`,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status: 'PAUSED',
      access_token: CONFIG.META_ACCESS_TOKEN,
    }
  );
  return res.data.id;
}

// ============================================================
// FULL LAUNCH FOR ONE AD
// AD167.mp4 → Drive → Meta video → Creative → Campaign → 3 ad sets
// ============================================================
async function launchOneAd(adRow) {
  const { adSequence, videoFile } = adRow;
  console.log(`\nLaunching ${adSequence}...`);

  try {
    // 1. Download video from Drive
    const videoPath = await getVideoFromDrive(videoFile);

    // 2. Upload to Meta
    const videoId = await uploadVideoToMeta(videoPath, adSequence);

    // 3. Create creative (pulls copy from FACEBOOK AD TEXT tab)
    const creativeId = await createAdCreative(videoId, adSequence);

    // 4. Create campaign
    const campaignId = await createCampaign(adSequence);

    // 5. Create 3 ad sets — Cardi B, Nicki Minaj, Broad
    const audiences = [
      { name: 'Cardi B',      interests: [{ id: '6003232518610', name: 'Cardi B' }] },
      { name: 'Nicki Minaj',  interests: [{ id: '6003349380994', name: 'Nicki Minaj' }] },
      { name: 'Broad',        interests: null },
    ];

    for (const audience of audiences) {
      const adSetId = await createAdSet(campaignId, audience.name, audience.interests, adSequence);
      await createAd(adSetId, creativeId, adSequence, audience.name);
      console.log(`  Created: ${adSequence} — ${audience.name}`);
    }

    // 6. Clean up temp file
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

    // 7. Mark as uploaded in sheet
    await markAdAsUploaded(adSequence);

    console.log(`${adSequence} launched. Campaign PAUSED — approve in Meta before going live.`);
    return { success: true, adSequence, campaignId };

  } catch (err) {
    console.error(`Error launching ${adSequence}:`, err.message);
    return { success: false, adSequence, error: err.message };
  }
}

// ============================================================
// SEND EMAIL REPORT
// ============================================================
async function sendEmailReport(decisions, claudeOutput, launchResults) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
  });

  const kills   = decisions.filter(d => d.decision === 'KILL');
  const winners = decisions.filter(d => d.decision.includes('WINNER'));
  const watches = decisions.filter(d => d.decision.includes('WATCH'));
  const keeps   = decisions.filter(d => d.decision === 'KEEP RUNNING');

  const summaryMatch = claudeOutput.match(/WEEKLY SUMMARY:([\s\S]*?)(?=AD\d+ SCRIPT:|$)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : 'See full output below.';

  const launched = launchResults ? launchResults.filter(r => r.success) : [];
  const failed   = launchResults ? launchResults.filter(r => !r.success) : [];

  const ownerBody = `ANNMICHELL ADS WEEKLY REPORT — ${new Date().toDateString()}

${summary}

KILL THESE ADS NOW (${kills.length})
${kills.length === 0 ? 'None this week' : kills.map(d => `- ${d.adName}\n  REASON: ${d.reason}\n  ACTION: Meta Ads Manager > find this ad set > toggle OFF`).join('\n\n')}

WINNERS — PROMOTE TO PHASE 2 (${winners.length})
${winners.length === 0 ? 'No new winners — keep testing' : winners.map(d => `- ${d.adName} | ROAS ${d.roas.toFixed(2)}x\n  ACTION: New campaign at $50/day with same ad`).join('\n\n')}

WATCH LIST — ONE MORE WEEK (${watches.length})
${watches.map(d => `- ${d.adName} ROAS ${d.roas.toFixed(2)}x`).join('\n') || 'None'}

STILL RUNNING (${keeps.length})
${keeps.map(d => `- ${d.adName} ROAS ${d.roas.toFixed(2)}x`).join('\n') || 'None'}

NEW ADS LAUNCHED THIS WEEK (${launched.length})
${launched.length === 0 ? 'No new videos were marked READY TO LAUNCH in the sheet' : launched.map(r => `- ${r.adSequence}: Campaign created in Meta — STATUS: PAUSED\n  ACTION: Go to Meta Ads Manager and turn it ON to go live`).join('\n')}

${failed.length > 0 ? `LAUNCH ERRORS (${failed.length})\n${failed.map(r => `- ${r.adSequence}: ${r.error}`).join('\n')}` : ''}

NEW SCRIPTS IN SHEET
Check AD TEXT tab — new scripts have been added for next week.
Check FACEBOOK AD TEXT tab — ad copy has been generated for each script.
Creator must name their video files exactly: ${(launchResults || []).map(r => r.adSequence + '.mp4').join(', ') || 'ADxxx.mp4'}

PROFIT CHECK
Your profit per sale: $35 (at $125 price)
Max cost per purchase before losing money: $35
Check this every week.`;

  const buyerBody = `ANNMICHELL ADS ACTION LIST — ${new Date().toDateString()}

STEP 1 — TURN THESE ADS OFF TODAY
${kills.length === 0 ? 'Nothing to turn off this week.' : kills.map(d => `- ${d.adName}`).join('\n')}

STEP 2 — TURN THESE NEW CAMPAIGNS ON IN META
${launched.length === 0 ? 'No new campaigns this week.' : launched.map(r => `- ${r.adSequence} — find it in Meta Ads Manager, status is PAUSED, turn it ON`).join('\n')}

STEP 3 — PROMOTE TO PHASE 2 (new campaign at $50/day)
${winners.length === 0 ? 'No promotions this week.' : winners.map(d => `- ${d.adName}`).join('\n')}

STEP 4 — SEND SCRIPTS TO CREATOR
Open Google Sheet > AD TEXT tab > find the new scripts > send to Blanca
Creator must name video files exactly as shown in column G (e.g. AD167.mp4)
Creator uploads finished video to Google Drive folder

STEP 5 — MARK AS READY TO LAUNCH
When video is in Drive: change column L in AD TEXT tab to READY TO LAUNCH
The bot will pick it up automatically next Tuesday and upload to Meta.

That is everything. Takes 10 minutes.`;

  await transporter.sendMail({
    from: CONFIG.EMAIL_USER,
    to: CONFIG.EMAIL_TO_OWNER,
    subject: `Annmichell Ads Report — ${kills.length} kills · ${winners.length} winners · ${launched.length} launched`,
    text: ownerBody,
  });

  await transporter.sendMail({
    from: CONFIG.EMAIL_USER,
    to: CONFIG.EMAIL_TO_BUYER,
    subject: `Your Annmichell Action List — ${new Date().toDateString()}`,
    text: buyerBody,
  });

  console.log('Emails sent to owner and media buyer');
}

// ============================================================
// MONDAY JOB — runs at 8am every Monday
// 1. Read performance data
// 2. Apply kill rules
// 3. Get next AD sequence numbers (incremental)
// 4. Ask Claude for analysis + 3 new scripts + FB ad copy
// 5. Write scripts to AD TEXT tab
// 6. Write ad copy to FACEBOOK AD TEXT tab
// 7. Write decisions to AD PERFORMANCE REPORT tab
// 8. Send email reports
// ============================================================
async function mondayJob() {
  console.log('\n=== MONDAY JOB STARTING ===', new Date().toISOString());
  try {
    const adData    = await readPerformanceData();
    const decisions = applyKillRules(adData);

    const nextAdNumbers = await getNextAdSequenceNumbers(3);
    console.log(`Next AD sequences: ${nextAdNumbers.join(', ')}`);

    const claudeOutput = await askClaude(decisions, nextAdNumbers);
    const parsed       = parseClaude(claudeOutput, nextAdNumbers);

    await writeDecisionsToSheet(decisions);
    await writeScriptsToAdTextTab(parsed);
    await writeFacebookAdCopy(parsed);
    await sendEmailReport(decisions, claudeOutput, null);

    console.log('Monday job complete. Scripts written. Emails sent.');
  } catch (err) {
    console.error('Monday job error:', err.message);
  }
}

// ============================================================
// TUESDAY JOB — runs at 9am every Tuesday
// Looks for any AD in AD TEXT tab with status READY TO LAUNCH
// Downloads video from Drive, uploads to Meta, creates campaign
// Emails confirmation
// ============================================================
async function tuesdayJob() {
  console.log('\n=== TUESDAY JOB STARTING ===', new Date().toISOString());
  try {
    const adsToLaunch = await readAdsReadyToLaunch();

    if (adsToLaunch.length === 0) {
      console.log('No ads marked READY TO LAUNCH in sheet. Nothing to do.');
      return;
    }

    console.log(`Found ${adsToLaunch.length} ads ready to launch: ${adsToLaunch.map(a => a.adSequence).join(', ')}`);

    const results = [];
    for (const ad of adsToLaunch) {
      const result = await launchOneAd(ad);
      results.push(result);
    }

    // Send a simple launch confirmation email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
    });

    const launched = results.filter(r => r.success);
    const failed   = results.filter(r => !r.success);

    await transporter.sendMail({
      from: CONFIG.EMAIL_USER,
      to: CONFIG.EMAIL_TO_OWNER,
      subject: `Annmichell — ${launched.length} ads launched in Meta today`,
      text: `TUESDAY LAUNCH REPORT — ${new Date().toDateString()}

LAUNCHED (${launched.length})
${launched.map(r => `- ${r.adSequence}: Campaign created — STATUS: PAUSED\n  Go to Meta Ads Manager and turn it ON`).join('\n') || 'None'}

FAILED (${failed.length})
${failed.map(r => `- ${r.adSequence}: ${r.error}`).join('\n') || 'None'}

Remember: campaigns are created PAUSED. You must go to Meta and turn them ON before they spend money.
Each campaign has 3 ad sets: Cardi B interest, Nicki Minaj interest, Broad — $10/day each.`,
    });

    console.log('Tuesday job complete.');
  } catch (err) {
    console.error('Tuesday job error:', err.message);
  }
}

// ============================================================
// SCHEDULE
// Monday 8am ET  — analysis, scripts, ad copy, email report
// Tuesday 9am ET — launch any READY TO LAUNCH ads
// ============================================================
cron.schedule('0 8 * * 1', mondayJob,  { timezone: 'America/New_York' });
cron.schedule('0 9 * * 2', tuesdayJob, { timezone: 'America/New_York' });

console.log('Annmichell bot running.');
console.log('Monday 8am ET  — weekly report + new scripts');
console.log('Tuesday 9am ET — launch READY TO LAUNCH ads');
console.log(`Current time: ${new Date().toISOString()}`);

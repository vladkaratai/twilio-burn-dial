require('dotenv').config();
const express = require('express');
const http = require('http');
const twilio = require('twilio');
const { twiml } = twilio;
const webhook = twilio.webhook;
const twilioClient = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const server = http.createServer(app);

const allowedOrigins = ['http://localhost:5173'];
if (process.env.DOMAIN_NAME) allowedOrigins.push(process.env.DOMAIN_NAME);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const twilioWebhook = webhook({ validate: false });

const activeCalls = new Map();
const activeIntervals = new Map();
const processedStatuses = new Map(); 

setInterval(() => {
  const now = Date.now();
  const TTL = 2 * 60 * 60 * 1000; 
  for (const [key, timestamp] of processedStatuses) {
    if (now - timestamp > TTL) {
      processedStatuses.delete(key);
      console.log(`[CLEANUP_INTERVAL] Cleaned up processedStatuses for key: ${key}`);
    }
  }
}, 60 * 60 * 1000);

async function logWebhook(eventType, req, status = 'received', error = null) {
  try {
    const callSidForLog = req.body.CallSid || 'N/A';
    const callStatusForLog = req.body.CallStatus || 'N/A';
    console.log(`[LOG_WEBHOOK_ATTEMPT] type: ${eventType}, status: ${status}, CallSid: ${callSidForLog}, CallStatus: ${callStatusForLog}`);
    await supabase.from('webhook_events').insert({
      event_type: eventType,
      call_sid: req.body.CallSid,
      parent_call_sid: req.body.ParentCallSid,
      status,
      error_snippet: error ? String(error).substring(0, 200) : null,
      payload: {
        From: req.body.From,
        To: req.body.To,
        CallStatus: req.body.CallStatus,
        CallDuration: req.body.CallDuration,
        full_payload: req.body
      }
    });
    console.log(`[LOG_WEBHOOK_SUCCESS] type: ${eventType}, status: ${status}, CallSid: ${callSidForLog}, CallStatus: ${callStatusForLog}`);
  } catch (e) {
    console.error('[LOG_WEBHOOK_ERROR] Failed to log webhook:', e.message, e.stack);
  }
}

app.post('/twiml/warning', (req, res) => {
  console.log(`[TWIML_ENDPOINT] /twiml/warning requested. CallSid: ${req.body.CallSid}`);
  const response = new twiml.VoiceResponse();
  response.say({ voice: 'alice', language: 'en-US' }, 'You have 5 minutes remaining.');
  res.type('text/xml').send(response.toString());
});

app.post('/twiml/timeout', (req, res) => {
  console.log(`[TWIML_ENDPOINT] /twiml/timeout requested. CallSid: ${req.body.CallSid}`);
  const response = new twiml.VoiceResponse();
  response.say({ voice: 'alice', language: 'en-US' }, 'Your time is up. Thank you for the call.');
  response.pause({length: 5});
  res.type('text/xml').send(response.toString());
});

app.post('/twilio/incoming-call', twilioWebhook, async (req, res) => {
  console.log(`[INCOMING_CALL] Webhook received at /twilio/incoming-call. CallSid: ${req.body.CallSid}`);
  await logWebhook('incoming_call', req);
  const { From: from, To: proxyNumber } = req.body;
  const twimlResponse = new twiml.VoiceResponse();

  try {
    const { data: serviceNumber, error: snErr } = await supabase
      .from('service_numbers')
      .select('creator_id, price_per_minute')
      .eq('number', proxyNumber)
      .single();

    if (snErr || !serviceNumber) {
      console.error(`[INCOMING_CALL_ERROR] Service number not found for ${proxyNumber}:`, snErr);
      twimlResponse.say('Service unavailable.');
      twimlResponse.hangup();
      await logWebhook('incoming_call', req, 'failed', 'Service number not found');
      return res.type('text/xml').send(twimlResponse.toString());
    }

    const pricePerMinute = Number(serviceNumber.price_per_minute) || 3;
    console.log(`[INCOMING_CALL] Service number found. Price per minute: ${pricePerMinute}`);

    const { data: hasBalance, error: balanceErr } = await supabase.rpc('check_balance', { p_phone: from, p_amount: pricePerMinute });

    if (balanceErr || !hasBalance) {
      console.warn(`[INCOMING_CALL_WARNING] Insufficient balance for ${from}. Needed: ${pricePerMinute}`, balanceErr);
      twimlResponse.say('Insufficient balance.');
      twimlResponse.hangup();
      await logWebhook('incoming_call', req, 'failed', 'Insufficient balance');
      return res.type('text/xml').send(twimlResponse.toString());
    }
    console.log(`[INCOMING_CALL] Balance check passed for ${from}.`);

    const { data: creator, error: creatorErr } = await supabase
      .from('creators')
      .select('name, phone')
      .eq('id', serviceNumber.creator_id)
      .single();

    if (creatorErr || !creator || !creator.phone) {
      console.error(`[INCOMING_CALL_ERROR] Creator not found for ID: ${serviceNumber.creator_id}`, creatorErr);
      twimlResponse.say('Expert unavailable.');
      twimlResponse.hangup();
      await logWebhook('incoming_call', req, 'failed', 'Creator not available');
      return res.type('text/xml').send(twimlResponse.toString());
    }
    console.log(`[INCOMING_CALL] Creator found: ${creator.name} (${creator.phone})`);

    const { data: balanceData, error: balErr } = await supabase.from('customer_balances').select('balance').eq('phone_number', from).single();

    if (balErr || !balanceData) {
      console.error(`[INCOMING_CALL_ERROR] Error fetching balance for ${from}`, balErr);
      twimlResponse.say('System error.');
      twimlResponse.hangup();
      await logWebhook('incoming_call', req, 'failed', 'Balance fetch error');
      return res.type('text/xml').send(twimlResponse.toString());
    }

    const currentBalance = Number(balanceData.balance);
    const availableMinutes = Math.floor(currentBalance / pricePerMinute);
    const expertName = creator.name || 'Expert';

    twimlResponse.say({ voice: 'alice', language: 'en-US' }, `Hello, my name is ${expertName}. You have ${availableMinutes} minutes available.`);

    const statusUrl = `${process.env.DOMAIN_NAME}/twilio/call-status?proxy=${encodeURIComponent(proxyNumber)}`;
    console.log(`[INCOMING_CALL] Generated statusCallback URL: ${statusUrl}`);

    twimlResponse.dial({ callerId: process.env.TWILIO_NUMBER, timeout: 30, answerOnBridge: true })
      .number({ statusCallback: statusUrl, statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'] }, creator.phone);

    console.log(`[INCOMING_CALL] TwiML response generated for dialing ${creator.phone}.`);
    await logWebhook('incoming_call', req, 'processed');
    res.type('text/xml').send(twimlResponse.toString());

  } catch (err) {
    console.error('[INCOMING_CALL_CRITICAL_ERROR] Unexpected error:', err.message, err.stack);
    twimlResponse.say('System error. Please try again.');
    twimlResponse.hangup();
    await logWebhook('incoming_call', req, 'failed', err.message);
    res.type('text/xml').send(twimlResponse.toString());
  }
});

app.post('/twilio/call-status', twilioWebhook, async (req, res) => {
  console.log(`[CALL_STATUS] Webhook received. CallSid: ${req.body.CallSid}, CallStatus: ${req.body.CallStatus}`);
  
  const { CallSid, CallStatus, CallDuration = '0', ParentCallSid } = req.body;
  const proxyNumber = req.query.proxy;
  const primaryCallSid = ParentCallSid || CallSid;

  const processedKey = `${CallSid}-${CallStatus}`;
  if (processedStatuses.has(processedKey)) {
    console.log(`[CALL_STATUS] Key '${processedKey}' already processed. Returning 200.`);
    return res.sendStatus(200);
  }
  processedStatuses.set(processedKey, Date.now());
  
  await logWebhook('call_status', req);
  console.log(`[CALL_STATUS] Processing: PrimaryCallSid: ${primaryCallSid}, ChildCallSid: ${CallSid}, Status: ${CallStatus}`);

  let pricePerMinute = 3;
  if (proxyNumber) {
    const { data: sn, error: snErr } = await supabase.from('service_numbers').select('price_per_minute').eq('number', proxyNumber).single();
    if (snErr) console.error(`[CALL_STATUS_ERROR] Error fetching service number ${proxyNumber}:`, snErr.message);
    else if (sn) pricePerMinute = Number(sn.price_per_minute) || 3;
  }

  if ((CallStatus === 'completed' && CallDuration === '0') || ['no-answer', 'failed', 'busy', 'canceled'].includes(CallStatus)) {
    console.log(`[CALL_STATUS_NO_CHARGE] Call ${CallSid} ended without connection. Status: ${CallStatus}.`);
    cleanupCall(primaryCallSid);
    return res.sendStatus(200);
  }

  if (CallStatus === 'answered' || CallStatus === 'in-progress') {
    console.log(`[CALL_STATUS_ANSWERED] Call ${CallSid} (primary: ${primaryCallSid}) ANSWERED/IN-PROGRESS.`);
    if (activeCalls.has(primaryCallSid)) {
      console.log(`[CALL_STATUS_ANSWERED] Monitoring already active for ${primaryCallSid}. Skipping.`);
      return res.sendStatus(200);
    }

    try {
      const parentCall = await twilioClient.calls(primaryCallSid).fetch();
      const customerPhoneNumber = parentCall.from;
      console.log(`[CALL_STATUS_ANSWERED] Fetched parent call. Customer phone number is: ${customerPhoneNumber}`);

      activeCalls.set(primaryCallSid, {
        caller: customerPhoneNumber,
        pricePerMinute,
        startTime: Date.now(),
        lastCheckedMinute: 0,
        warningPlayed: false
      });
      console.log(`[CALL_STATUS_ANSWERED] Added to activeCalls. Caller: ${customerPhoneNumber}, Price: ${pricePerMinute}`);

      const intervalId = setInterval(() => monitorCallByMinute(primaryCallSid), 20000); 
      activeIntervals.set(primaryCallSid, intervalId);
      console.log(`[CALL_STATUS_ANSWERED] Started monitoring interval for ${primaryCallSid}.`);
    } catch (e) {
      console.error(`[CALL_STATUS_ANSWERED_ERROR] Failed to fetch parent call or start monitoring for ${primaryCallSid}:`, e.message);
      cleanupCall(primaryCallSid);
    }
  }

  if (CallStatus === 'completed' && CallDuration !== '0') {
    console.log(`[CALL_STATUS_CHARGE] Call ${CallSid} (primary: ${primaryCallSid}) COMPLETED with duration ${CallDuration}. Attempting charge.`);
    const call = activeCalls.get(primaryCallSid);

    if (!call || !call.caller) {
      console.error(`[CALL_STATUS_CHARGE_ERROR] Caller not found in activeCalls for ${primaryCallSid}. Cannot charge.`);
      cleanupCall(primaryCallSid);
      return res.sendStatus(200);
    }

    const { caller: callerToCharge } = call;
    let billedMinutes;

    const elapsedSec = parseInt(CallDuration, 10);
    const factualMinutes = Math.max(1, Math.ceil(elapsedSec / 60));
    billedMinutes = Math.min(factualMinutes, call.lastCheckedMinute > 0 ? call.lastCheckedMinute : factualMinutes);
    console.log(`[CALL_STATUS_CHARGE] Calculated: elapsedSec=${elapsedSec}, factualMinutes=${factualMinutes}, billedMinutes=${billedMinutes}`);

    const totalAmount = billedMinutes * pricePerMinute;
    console.log(`[CALL_STATUS_CHARGE] Attempting to charge ${totalAmount} for ${billedMinutes} minutes to ${callerToCharge}`);

    const { data: success, error } = await supabase.rpc('charge_call', { p_phone: callerToCharge, p_amount: totalAmount, p_min_balance: 0 });

    if (error || !success) {
      console.error(`[CALL_STATUS_CHARGE_FAILED] Billing failed for ${callerToCharge}, amount: ${totalAmount}, Error:`, error?.message, error?.details);
    } else {
      console.log(`[CALL_STATUS_CHARGE_SUCCESS] ✅ Billed ${totalAmount} for ${billedMinutes} minutes for ${callerToCharge}`);
    }
    cleanupCall(primaryCallSid);
  }

  res.sendStatus(200);
});


async function monitorCallByMinute(primaryCallSid) {
  console.log(`[MONITOR] Checking call ${primaryCallSid}...`);
  const call = activeCalls.get(primaryCallSid);
  if (!call) {
    console.log(`[MONITOR] Call ${primaryCallSid} not found in activeCalls. Stopping monitoring.`);
    if (activeIntervals.has(primaryCallSid)) {
        clearInterval(activeIntervals.get(primaryCallSid));
        activeIntervals.delete(primaryCallSid);
    }
    return;
  }

  try {
    const { data: balanceData, error: balErr } = await supabase.from('customer_balances').select('balance').eq('phone_number', call.caller).single();

    if (balErr || !balanceData) {
      console.error(`[MONITOR_ERROR] Balance fetch error for ${call.caller}. Will retry next interval.`, balErr?.message);
      return; 
    }

    const currentBalance = Number(balanceData.balance);
    const maxAffordableMinutes = Math.floor(currentBalance / call.pricePerMinute);
    const elapsedSec = Math.floor((Date.now() - call.startTime) / 1000);
    const currentMinute = Math.ceil(elapsedSec / 60);

    console.log(`[MONITOR] Call ${primaryCallSid}: Caller: ${call.caller}, Balance: ${currentBalance}, Max Mins: ${maxAffordableMinutes}, Elapsed Sec: ${elapsedSec}`);
    
    if (currentMinute > maxAffordableMinutes) {
      console.log(`[MONITOR_TIMEOUT] Call ${primaryCallSid} exceeding max minutes (${currentMinute} > ${maxAffordableMinutes}). Hanging up.`);
      try {
        await twilioClient.calls(primaryCallSid).update({ url: `${process.env.DOMAIN_NAME}/twiml/timeout`, method: 'POST' });
        if (activeIntervals.has(primaryCallSid)) {
            clearInterval(activeIntervals.get(primaryCallSid));
            activeIntervals.delete(primaryCallSid);
            console.log(`[MONITOR_TIMEOUT] Stopped monitoring interval for ${primaryCallSid} after sending hangup command.`);
        }
      } catch (e) {
        console.error(`[MONITOR_TIMEOUT_ERROR] Failed to hangup call ${primaryCallSid}:`, e.message);
      }
    } else {
      call.lastCheckedMinute = maxAffordableMinutes;
    }
  } catch (err) {
    console.error(`[MONITOR_CRITICAL_ERROR] Unexpected critical error for ${primaryCallSid}:`, err.message);
  }
}

function cleanupCall(callSid) {
  console.log(`[CLEANUP] Cleaning up call data for CallSid: ${callSid}`);
  if (activeIntervals.has(callSid)) {
    clearInterval(activeIntervals.get(callSid));
    activeIntervals.delete(callSid);
    console.log(`[CLEANUP] Cleared interval for ${callSid}`);
  }
  if (activeCalls.has(callSid)) {
    activeCalls.delete(callSid);
    console.log(`[CLEANUP] Deleted active call entry for ${callSid}`);
  }
}

app.post('/topup', async (req, res) => {
  console.log(`[TOPUP] Received topup request. Phone: ${req.body.phoneNumber || 'N/A'}, Amount: ${req.body.amount || 'N/A'}`);
  const { phoneNumber, amount, idempotencyKey } = req.body;
  if (!phoneNumber || !amount || !idempotencyKey) {
    console.warn('[TOPUP_ERROR] Missing fields in topup request.');
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { data: success, error } = await supabase.rpc('safe_topup', { p_key: idempotencyKey, p_phone: phoneNumber, p_amount: Number(amount) });

  if (error || !success) {
    console.error(`[TOPUP_ERROR] Top-up failed for ${phoneNumber}, amount: ${amount}. Error:`, error?.message);
    return res.status(400).json({ success: false, error: 'Top-up failed or duplicate' });
  }

  console.log(`[TOPUP_SUCCESS]  Successfully topped up ${amount} for ${phoneNumber}.`);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
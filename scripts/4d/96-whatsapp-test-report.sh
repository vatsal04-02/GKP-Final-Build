#!/usr/bin/env bash
# READ-ONLY report of the supervised WhatsApp test: what the authorized test number sent, what the clinic answered, how the AI decided, what was handed to
# staff, what W12 sent or blocked, and any n8n error. Shows message text ONLY for the authorized test number (default 919322146560).
#   ./scripts/4d/96-whatsapp-test-report.sh [minutes=60]
. "$(dirname "$0")/common.sh"
MIN="${1:-60}"; TEST="${TEST_NUMBER:-919322146560}"
docker exec -i -e MIN="$MIN" -e TEST="$TEST" -e SLUG="$CLINIC" "$(cid flowhq)" node - <<'EOF'
const h={Authorization:"Bearer "+process.env.GRIST_API_KEY},b=process.env.GRIST_BASE_URL; const since=Date.now()/1000-Number(process.env.MIN)*60; const T=process.env.TEST;
(async()=>{const reg=await (await fetch(b+"/api/docs/"+process.env.GRIST_REGISTRY_DOC_ID+"/tables/Clinics/records",{headers:h})).json(); const id=reg.records.find(r=>r.fields.Clinic_Slug===process.env.SLUG).fields.Grist_Doc_ID;
const g=async t=>(await (await fetch(b+"/api/docs/"+id+"/tables/"+t+"/records",{headers:h})).json()).records||[];
const L=await g("LEADS"), M=await g("Messages"), C=await g("Conversations"), S=await g("Send_Ledger"), R=await g("Run_Log"), A=await g("Appointments");
const lead=L.find(r=>String(r.fields.Phone).replace(/\D/g,"")===T); const lid=lead&&lead.id;
console.log("test number lead: "+(lead?("row "+lead.id+" "+lead.fields.Lead_id+" status="+lead.fields.Status+" consent_whatsapp="+lead.fields.Consent_WhatsApp+" opted_out="+lead.fields.Opted_Out):"NOT FOUND (no inbound from the test number yet)"));
const conv=C.filter(r=>r.fields.Lead===lid); for(const c of conv) console.log("conversation "+c.id+": automation_paused="+c.fields.Automation_Paused+" needs_human="+c.fields.Needs_Human);
const ms=M.filter(r=>conv.some(c=>c.id===r.fields.Conversation)&&(r.fields.Timestamp||r.fields.Created_At||0)>=since).sort((a,b)=>a.id-b.id);
console.log("--- messages with the test number in the last "+process.env.MIN+" min ("+ms.length+")");
for(const m of ms){const f=m.fields; console.log((f.Direction==="In"?"  PATIENT : ":"  CLINIC  : ")+String(f.Body).replace(/\s+/g," ").slice(0,300)); if(f.Direction==="In") console.log("            AI: intent="+(f.Intent||"-")+" action="+(f.AI_Action||"-")+" status="+(f.AI_Status||"-")+" confidence="+(f.AI_Confidence??"-")+(f.Needs_Human?" NEEDS_HUMAN":"")+(f.AI_Reason?" why="+String(f.AI_Reason).slice(0,160):"")); else console.log("            sent_by="+(f.Sent_By||f.Sender||"-")+" status="+(f.Status||"-")); }
console.log("--- Send_Ledger (last "+process.env.MIN+" min)"); const sl=S.filter(r=>(r.fields.Created_At||r.fields.Updated_At||0)>=since); for(const r of sl) console.log("  "+JSON.stringify({purpose:r.fields.Purpose||r.fields.Kind,status:r.fields.Status,to:String(r.fields.To||r.fields.Phone||"").replace(/\d(?=\d{4})/g,"*"),error:String(r.fields.Error||"").slice(0,80)})); if(!sl.length) console.log("  (none)");
console.log("--- Run_Log (last "+process.env.MIN+" min, W2/W12/W13)"); for(const r of R.filter(r=>(r.fields.Timestamp||r.fields.Created_At||0)>=since && /W2|W12|W13/.test(String(r.fields.Workflow)))) console.log("  "+r.fields.Workflow+" / "+r.fields.Outcome+" / "+String(r.fields.Error||r.fields.Record||"").slice(0,170));
console.log("--- appointments written through FLOW HQ (Booking_Source WhatsApp AI): "+A.filter(r=>r.fields.Booking_Source==="WhatsApp AI").map(r=>r.fields.Booking_UID+" "+r.fields.Status+" "+r.fields.Slot_Key).join("; ")||"none");
})().catch(e=>console.log("ERR "+e.message))
EOF
echo "--- n8n errors in the same window"; docker logs --since "${MIN}m" "$(cid n8n)" 2>&1 | grep -iE 'error|failed|credential|401|403|429|openrouter' | grep -v 'Python\|localstorage\|trace-warnings' | cut -c1-220 | tail -12; echo "(end)"

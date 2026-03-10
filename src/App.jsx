import { useState, useEffect, useRef, useCallback } from "react";

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SUPABASE_URL = (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL) || "";
const SUPABASE_KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY) || "";

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.headers || {}),
    },
  });
  return res;
}

// ── Section review prompts ────────────────────────────────────────────────────
const REVIEW_PROMPTS = {
  intro: (data) => `You are a warm, encouraging debt payoff assistant named Clearpath. The user just entered their name.

Name entered: "${data.name}"

Write a brief, warm welcome (2-3 sentences max). Use their name. Tell them what's coming next (income section). Be encouraging — mention that most people never take this step. Keep it conversational, not clinical. Do NOT ask any clarifying questions for this section.`,

  income: (data) => `You are a warm, encouraging debt payoff assistant. The user just filled out their income section.

INCOME DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Give a warm 1-sentence acknowledgment
2. Show a clean summary: "Here's what I have for your income: [list each source with amount, total monthly take-home]"
3. Ask ONE clarifying question ONLY if something seems off (e.g. take-home seems very high or very low vs gross, or a field that looks like it might be an annual number entered as monthly). If everything looks reasonable, just ask "Does this look right, or anything to adjust?"
4. Keep it conversational and warm. Never judgmental.`,

  expenses_regular: (data) => `You are a warm, encouraging debt payoff assistant. The user just filled out their monthly expenses.

MONTHLY EXPENSES DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Give a brief warm acknowledgment
2. Show their total: "Your monthly expenses come to $[total]."
3. Flag ONLY if something obvious seems missing or off (e.g. $0 for groceries AND dining, no housing cost at all). Don't nitpick small amounts.
4. Ask "Does that total look about right? Anything to add or adjust?"
5. Be warm and non-judgmental. Many numbers are estimates.`,

  expenses_irregular: (data) => `You are a warm, encouraging debt payoff assistant. The user just filled out their annual/irregular expenses.

ANNUAL EXPENSES DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Brief warm acknowledgment
2. Show the total and monthly equivalent: "Your annual irregular costs add up to $[annual], which is about $[annual/12]/month spread across the year."
3. Mention 1-2 commonly forgotten items IF they have nothing filled in for major categories (e.g. no car insurance at all, no holiday spending). Don't guilt them.
4. Ask "Does this look complete, or anything to add?"`,

  debts: (data) => `You are a warm, encouraging debt payoff assistant. The user just entered all their debts.

DEBT DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Brief warm acknowledgment — normalize having debt, this is why they're here
2. Show a clean debt summary: list each debt with balance and rate, total debt, total minimum payments
3. Flag ONLY clear data issues: interest rate of 0% on a credit card (ask if that's a promo rate), or a rate above 35% (confirm that's right)
4. Ask "Does this list look complete? Any other debts to add?"
5. Never make them feel bad about the amount.`,

  goals: (data) => `You are a warm, encouraging debt payoff assistant. The user is about to set their monthly commitment.

COMPLETE FINANCIAL PICTURE:
${JSON.stringify(data, null, 2)}

This is the most important section. Your job:
1. Acknowledge they're almost done — just this last section
2. Show them their financial picture clearly:
   "Here's where things stand, [name]:
   • Monthly take-home: $[total income]
   • Monthly expenses: $[total expenses] (including $[monthly irregular equiv]/mo set aside for annual costs)
   • Monthly minimums on your debts: $[total mins]
   • **True monthly surplus after everything: $[income - expenses - minimums]**"
3. Explain what the surplus means for their plan — if positive, tell them that's what's available to attack debt. If tight or negative, be honest but warm.
4. Then say: "Now, realistically — you don't have to commit all of that. Many people keep a buffer for life's surprises. What amount feels sustainable to put toward debt each month?"
5. Do NOT answer the commitment question for them. Just set up the context and ask.`,
};

const PLAN_SYSTEM_PROMPT = `You are an expert debt payoff advisor. The user has filled out a structured form with their complete financial data. Analyze it and produce three complete debt payoff plans.

CRITICAL RULES:
- Use ONLY the data provided. Never invent numbers, names, or dates.
- Today's date is provided in the payload. All payoff dates MUST be after today.
- Be warm and encouraging but mathematically precise.

DEBT MATH:
- Monthly interest: (rate / 12) × balance
- Principal paid: payment - interest
- Cascade: when debt hits $0, its minimum rolls to next target
- Extra monthly = monthly_committed - sum of all minimums
- Deferred loans: balance grows monthly, no payments until activation
- HELOC IO: minimum = (rate/12) × balance only

OUTPUT — respond with exactly this structure:

## Your Three Plans

### 📊 Plan A — Avalanche (Highest Rate First)
Attack order: [list highest to lowest rate]
- 🗓️ Debt-free date: [Month Year — MUST be future]
- 💸 Total interest paid: $[X]
- 💰 Saves $[X] vs. minimums only forever
- 🎉 First debt gone: [name] — [Month Year]
- ⚖️ Tradeoff: [honest 1-sentence tradeoff]

### 🏆 Plan B — Snowball (Smallest Balance First)
Attack order: [list smallest to largest balance]
- 🗓️ Debt-free date: [Month Year]
- 💸 Total interest paid: $[X]
- 💰 Saves $[X] vs. minimums only
- 🎉 First debt gone: [name] — [Month Year] ([X] months away!)
- ⚖️ Tradeoff: [honest comparison to Plan A]

### ⭐ Plan C — [Custom Name]
[Consider HELOC cliffs, deferred loan dates, emotional priorities, emergency fund gap]
Attack order: [list]
- 🗓️ Debt-free date: [Month Year]
- 💸 Total interest paid: $[X]
- 💰 Saves $[X] vs. minimums only
- ✅ Why this plan: [2 sentences using their actual debt names]
- ⚖️ Tradeoff: [honest tradeoff]

---

## 🎯 My Recommendation
[2-3 sentences using their actual debt names and numbers]

---

## 📈 The Big Picture
- Total debt today: $[X]
- Minimums-only payoff date: [Month Year]
- Best plan saves you: $[X] in interest
- Best plan debt-free date: [Month Year] — [X] years sooner

---

## 💬 Ask Me Anything
Your plan is ready. Try asking:
- "What if I get a bonus next month?"
- "What should I pay first this month?"
- "Explain the avalanche method"`;

const emptyForm = {
  name: "",
  monthly_takehome: "", partner_income: "", other_income: "", gross_annual: "",
  bonus_amount: "", bonus_month: "",
  rent_mortgage: "", property_tax: "", hoa: "",
  electric_gas: "", water: "", internet: "",
  streaming: "", phone: "",
  car_payment: "", car_insurance_monthly: "", gas: "",
  groceries: "", dining: "",
  health_insurance: "", medical_copays: "",
  childcare: "", pets: "", personal_care: "", gym: "",
  savings_transfers: "", misc_buffer: "", other_monthly: "",
  car_insurance_annual: "", home_insurance_annual: "", amazon_prime: "",
  car_registration: "", vet_annual: "", holiday_spending: "",
  vacation_annual: "", other_irregular: "",
  debts: [],
  extra_income: [],
  extra_monthly: [],
  extra_annual: [],
  monthly_committed: "", emergency_fund_current: "", emergency_fund_target: "",
  priority: "balanced", open_to_refi: false,
  emotional_priority: "", upcoming_expenses: "",
};

const emptyDebt = {
  name: "", balance: "", rate: "", min: "", type: "credit_card",
  deferred: false, deferred_until_month: "", deferred_until_year: "",
  is_heloc_io: false, heloc_draw_ends_month: "", heloc_draw_ends_year: "",
};

const DEBT_TYPES = ["credit_card","student_loan","auto","mortgage","heloc","personal","medical","other"];
const PRIORITIES = [
  { value: "speed", label: "🏁 Speed", desc: "Debt-free as fast as possible" },
  { value: "save_interest", label: "💰 Save Money", desc: "Pay least total interest" },
  { value: "cash_flow", label: "📆 Free Up Cash", desc: "Lower monthly bills quickly" },
  { value: "balanced", label: "⚖️ Balanced", desc: "Reasonable middle ground" },
];

const SECTIONS = [
  { id: "intro", label: "👋 Welcome", icon: "👋" },
  { id: "income", label: "💵 Income", icon: "💵" },
  { id: "expenses_regular", label: "📋 Monthly Expenses", icon: "📋" },
  { id: "expenses_irregular", label: "📆 Annual Expenses", icon: "📆" },
  { id: "debts", label: "💳 Your Debts", icon: "💳" },
  { id: "goals", label: "🎯 Goals & Commitment", icon: "🎯" },
];

const emptyReview = { status: "idle", messages: [], input: "", loading: false };

// ── Shared UI components ──────────────────────────────────────────────────────
const inputStyle = { width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:8, color:"#f1f5f9", fontSize:14, padding:"10px 14px", outline:"none", boxSizing:"border-box" };
const labelStyle = { display:"block", fontSize:12, fontWeight:600, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 };

function Field({ label, name, placeholder, hint, prefix, suffix, type="text", form, setField }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={labelStyle}>{label}</label>
      <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:8, border:"1px solid #334155", overflow:"hidden" }}>
        {prefix && <span style={{ padding:"0 10px", color:"#475569", fontSize:14, borderRight:"1px solid #334155", lineHeight:"40px" }}>{prefix}</span>}
        <input type={type} value={form[name]||""} onChange={e=>setField(name,e.target.value)} placeholder={placeholder} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:14, padding:"0 12px", height:40 }} />
        {suffix && <span style={{ padding:"0 10px", color:"#475569", fontSize:12 }}>{suffix}</span>}
      </div>
      {hint && <p style={{ fontSize:11, color:"#475569", marginTop:4 }}>{hint}</p>}
    </div>
  );
}

function Row2({ children }) { return <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>{children}</div>; }

function Divider({ label }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, margin:"20px 0 14px" }}>
      <div style={{ flex:1, height:1, background:"#1e293b" }} />
      <span style={{ fontSize:10, fontWeight:700, color:"#334155", textTransform:"uppercase", letterSpacing:"0.1em" }}>{label}</span>
      <div style={{ flex:1, height:1, background:"#1e293b" }} />
    </div>
  );
}

function ExtraItems({ listKey, items, prefix, addItem, updateItem, removeItem, addLabel = "+ Add custom item" }) {
  return (
    <div style={{ marginTop:4 }}>
      {items.map((item, idx) => (
        <div key={item.id || idx} style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8 }}>
          <input value={item.name} onChange={e=>updateItem(listKey,idx,"name",e.target.value)} placeholder="Label (e.g. Side hustle)" style={{ flex:2, background:"#1e293b", border:"1px solid #334155", borderRadius:8, color:"#f1f5f9", fontSize:13, padding:"9px 12px", outline:"none" }} />
          <div style={{ flex:1, display:"flex", alignItems:"center", background:"#1e293b", border:"1px solid #334155", borderRadius:8, overflow:"hidden" }}>
            {prefix && <span style={{ padding:"0 8px", color:"#475569", fontSize:13 }}>{prefix}</span>}
            <input value={item.amount} onChange={e=>updateItem(listKey,idx,"amount",e.target.value)} placeholder="0" style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:13, padding:"9px 6px" }} />
          </div>
          <button onClick={()=>removeItem(listKey,idx)} style={{ background:"none", border:"none", color:"#334155", cursor:"pointer", fontSize:16, padding:"0 4px" }}>✕</button>
        </div>
      ))}
      <button onClick={()=>addItem(listKey)}
        style={{ background:"transparent", border:"1px dashed #1e293b", borderRadius:8, color:"#334155", fontSize:12, fontWeight:600, padding:"8px 16px", cursor:"pointer", marginTop:2 }}
        onMouseEnter={e=>{e.target.style.borderColor="#22a89a";e.target.style.color="#22a89a";}}
        onMouseLeave={e=>{e.target.style.borderColor="#1e293b";e.target.style.color="#334155";}}>
        {addLabel}
      </button>
    </div>
  );
}

// ── Inline AI review chat thread ──────────────────────────────────────────────
function ReviewPanel({ sectionId, review, onSendMessage, onConfirm, onEdit }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:"smooth" }); }, [review.messages]);

  return (
    <div style={{ marginTop:20, borderRadius:12, border:"1px solid #1e3a34", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ background:"#0d2420", padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:14 }}>🧭</span>
          <span style={{ fontSize:12, fontWeight:700, color:"#22a89a" }}>Clearpath Review</span>
        </div>
        {review.status === "confirmed" && (
          <button onClick={onEdit} style={{ background:"none", border:"1px solid #334155", borderRadius:6, color:"#475569", fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
            Edit section
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ background:"#0a1f1c", padding:14, display:"flex", flexDirection:"column", gap:10, maxHeight:300, overflowY:"auto" }}>
        {review.messages.map((m, i) => (
          <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
            <div style={{
              maxWidth:"88%", padding:"9px 13px",
              borderRadius: m.role==="user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
              background: m.role==="user" ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e293b",
              color:"#f1f5f9", fontSize:13, lineHeight:1.6,
              whiteSpace:"pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {review.loading && (
          <div style={{ display:"flex" }}>
            <div style={{ background:"#1e293b", borderRadius:"12px 12px 12px 3px", padding:"9px 13px" }}>
              <span style={{ color:"#475569", fontSize:12 }}>Reviewing…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input or Confirm */}
      {review.status === "reviewing" && (
        <div style={{ background:"#0a1f1c", padding:10, borderTop:"1px solid #1e3a34" }}>
          <div style={{ display:"flex", gap:7, marginBottom:8 }}>
            <input
              value={review.input}
              onChange={e => onSendMessage(sectionId, "input", e.target.value)}
              onKeyDown={e => e.key==="Enter" && !e.shiftKey && onSendMessage(sectionId, "send")}
              placeholder="Reply to Clearpath…"
              style={{ flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:7, color:"#f1f5f9", fontSize:13, padding:"9px 12px", outline:"none" }}
            />
            <button onClick={()=>onSendMessage(sectionId,"send")} disabled={review.loading || !review.input.trim()}
              style={{ background:"linear-gradient(135deg,#1A7A6E,#22a89a)", border:"none", borderRadius:7, padding:"9px 14px", cursor:"pointer", color:"white", fontSize:13 }}>→</button>
          </div>
          <button onClick={onConfirm}
            style={{ width:"100%", background:"linear-gradient(135deg,#1A7A6E,#22a89a)", border:"none", borderRadius:8, color:"white", fontSize:13, fontWeight:700, padding:"11px 0", cursor:"pointer" }}>
            ✓ Looks good — continue →
          </button>
        </div>
      )}

      {review.status === "confirmed" && (
        <div style={{ background:"#0a1f1c", padding:"10px 14px", borderTop:"1px solid #1e3a34", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:13 }}>✅</span>
          <span style={{ fontSize:12, color:"#4ade80", fontWeight:600 }}>Section confirmed</span>
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("code");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [sessionRow, setSessionRow] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [openSection, setOpenSection] = useState("intro");
  // reviews: { [sectionId]: { status, messages, input, loading } }
  const [reviews, setReviews] = useState(() =>
    Object.fromEntries(SECTIONS.map(s => [s.id, { ...emptyReview }]))
  );
  const [planLoading, setPlanLoading] = useState(false);
  const [planText, setPlanText] = useState("");
  const [planError, setPlanError] = useState("");
  const [qaMessages, setQaMessages] = useState([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaEndRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => { qaEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [qaMessages]);

  useEffect(() => {
    if (!sessionRow) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      sbFetch(`access_codes?id=eq.${sessionRow.id}`, {
        method:"PATCH",
        body: JSON.stringify({ session_data: { form, planText, qaMessages, reviews, openSection } }),
      });
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [form, planText, qaMessages, reviews, openSection]);

  async function handleValidateCode() {
    if (!code.trim()) return;
    setCodeLoading(true); setCodeError("");
    try {
      const res = await fetch("/api/validate-code", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      const data = await res.json();
      if (!res.ok) { setCodeError(data.error || "Invalid code"); return; }
      setSessionRow(data.row);
      const sd = data.row.session_data;
      if (sd?.planText) {
        setForm(sd.form || emptyForm);
        setPlanText(sd.planText || "");
        setQaMessages(sd.qaMessages || []);
        if (sd.reviews) setReviews(sd.reviews);
        if (sd.openSection) setOpenSection(sd.openSection);
        setScreen("plan");
      } else if (sd?.form) {
        setForm(sd.form);
        if (sd.reviews) setReviews(sd.reviews);
        if (sd.openSection) setOpenSection(sd.openSection);
        setScreen("form");
      } else {
        setScreen("form");
      }
    } catch { setCodeError("Connection error. Try again."); }
    finally { setCodeLoading(false); }
  }

  const setField = (key, val) => setForm(f => ({ ...f, [key]: val }));

  function addDebt() { setForm(f => ({ ...f, debts: [...f.debts, { ...emptyDebt, id: Date.now() }] })); }
  function updateDebt(idx, key, val) { setForm(f => { const d=[...f.debts]; d[idx]={...d[idx],[key]:val}; return {...f,debts:d}; }); }
  function removeDebt(idx) { setForm(f => ({ ...f, debts: f.debts.filter((_,i)=>i!==idx) })); }
  function addItem(lk) { setForm(f => ({ ...f, [lk]: [...f[lk], { id:Date.now(), name:"", amount:"" }] })); }
  function updateItem(lk, idx, key, val) { setForm(f => { const a=[...f[lk]]; a[idx]={...a[idx],[key]:val}; return {...f,[lk]:a}; }); }
  function removeItem(lk, idx) { setForm(f => ({ ...f, [lk]: f[lk].filter((_,i)=>i!==idx) })); }

  // ── Build section-specific payload for review ─────────────────────────────
  function buildReviewData(sectionId) {
    const f = form;
    const extraIncomeTotal = f.extra_income.reduce((a,v)=>a+(parseFloat(v.amount)||0),0);
    const monthlyIn = [f.monthly_takehome,f.partner_income,f.other_income].reduce((a,v)=>a+(parseFloat(v)||0),0)+extraIncomeTotal;
    const regularExpTotal = [
      f.rent_mortgage,f.property_tax,f.hoa,f.electric_gas,f.water,f.internet,
      f.streaming,f.phone,f.car_payment,f.car_insurance_monthly,f.gas,
      f.groceries,f.dining,f.health_insurance,f.medical_copays,
      f.childcare,f.pets,f.personal_care,f.gym,f.savings_transfers,f.misc_buffer,f.other_monthly,
      ...f.extra_monthly.map(e=>e.amount)
    ].reduce((a,v)=>a+(parseFloat(v)||0),0);
    const annualTotal = [
      f.car_insurance_annual,f.home_insurance_annual,f.amazon_prime,f.car_registration,
      f.vet_annual,f.holiday_spending,f.vacation_annual,f.other_irregular,
      ...f.extra_annual.map(e=>e.amount)
    ].reduce((a,v)=>a+(parseFloat(v)||0),0);
    const monthlyIrregEquiv = annualTotal/12;
    const totalMins = f.debts.reduce((a,d)=>a+(parseFloat(d.min)||0),0);

    switch(sectionId) {
      case "intro": return { name: f.name };
      case "income": return {
        name: f.name,
        monthly_takehome: parseFloat(f.monthly_takehome)||0,
        partner_income: parseFloat(f.partner_income)||0,
        other_income: parseFloat(f.other_income)||0,
        extra_income: f.extra_income.filter(e=>e.name),
        gross_annual: parseFloat(f.gross_annual)||0,
        bonus_amount: parseFloat(f.bonus_amount)||0,
        bonus_month: f.bonus_month,
        total_monthly_income: Math.round(monthlyIn),
      };
      case "expenses_regular": return {
        name: f.name,
        expenses: {
          housing: { rent_mortgage:parseFloat(f.rent_mortgage)||0, property_tax:parseFloat(f.property_tax)||0, hoa:parseFloat(f.hoa)||0 },
          utilities: { electric_gas:parseFloat(f.electric_gas)||0, water:parseFloat(f.water)||0, internet:parseFloat(f.internet)||0 },
          services: { streaming:parseFloat(f.streaming)||0, phone:parseFloat(f.phone)||0 },
          transport: { car_payment:parseFloat(f.car_payment)||0, car_insurance_monthly:parseFloat(f.car_insurance_monthly)||0, gas:parseFloat(f.gas)||0 },
          food: { groceries:parseFloat(f.groceries)||0, dining:parseFloat(f.dining)||0 },
          health: { health_insurance:parseFloat(f.health_insurance)||0, medical_copays:parseFloat(f.medical_copays)||0 },
          personal: { childcare:parseFloat(f.childcare)||0, pets:parseFloat(f.pets)||0, personal_care:parseFloat(f.personal_care)||0, gym:parseFloat(f.gym)||0 },
          savings: { savings_transfers:parseFloat(f.savings_transfers)||0, misc_buffer:parseFloat(f.misc_buffer)||0, other_monthly:parseFloat(f.other_monthly)||0 },
          custom: f.extra_monthly.filter(e=>e.name),
        },
        total_monthly_expenses: Math.round(regularExpTotal),
      };
      case "expenses_irregular": return {
        name: f.name,
        annual_expenses: {
          car_insurance: parseFloat(f.car_insurance_annual)||0,
          home_insurance: parseFloat(f.home_insurance_annual)||0,
          memberships: parseFloat(f.amazon_prime)||0,
          car_registration: parseFloat(f.car_registration)||0,
          vet: parseFloat(f.vet_annual)||0,
          holiday: parseFloat(f.holiday_spending)||0,
          vacation: parseFloat(f.vacation_annual)||0,
          other: parseFloat(f.other_irregular)||0,
          custom: f.extra_annual.filter(e=>e.name),
        },
        total_annual: Math.round(annualTotal),
        monthly_equivalent: Math.round(monthlyIrregEquiv),
      };
      case "debts": return {
        name: f.name,
        debts: f.debts.map(d=>({
          name:d.name, balance:parseFloat(d.balance)||0,
          rate:parseFloat(d.rate)||0, min:parseFloat(d.min)||0,
          type:d.type, deferred:d.deferred,
          deferred_until: d.deferred?`Month ${d.deferred_until_month} ${d.deferred_until_year}`:null,
          is_heloc_io:d.is_heloc_io,
        })),
        total_debt: f.debts.reduce((a,d)=>a+(parseFloat(d.balance)||0),0),
        total_minimums: Math.round(totalMins),
      };
      case "goals": return {
        name: f.name,
        monthly_income: Math.round(monthlyIn),
        monthly_regular_expenses: Math.round(regularExpTotal),
        monthly_irregular_equiv: Math.round(monthlyIrregEquiv),
        total_monthly_expenses: Math.round(regularExpTotal + monthlyIrregEquiv),
        total_debt_minimums: Math.round(totalMins),
        true_surplus: Math.round(monthlyIn - regularExpTotal - monthlyIrregEquiv - totalMins),
        debts_summary: f.debts.map(d=>({ name:d.name, balance:parseFloat(d.balance)||0, min:parseFloat(d.min)||0 })),
        priority_set: f.priority,
        emergency_fund_current: parseFloat(f.emergency_fund_current)||0,
        emergency_fund_target: parseFloat(f.emergency_fund_target)||0,
        open_to_refi: f.open_to_refi,
      };
      default: return {};
    }
  }

  // ── Trigger AI review for a section ──────────────────────────────────────
  async function startReview(sectionId) {
    const data = buildReviewData(sectionId);
    const prompt = REVIEW_PROMPTS[sectionId]?.(data);
    if (!prompt) return;

    setReviews(r => ({ ...r, [sectionId]: { status:"reviewing", messages:[], input:"", loading:true } }));

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-haiku-4-5-20251001",
          max_tokens:500,
          messages:[{ role:"user", content:prompt }],
        }),
      });
      const d = await res.json();
      const text = d.content?.[0]?.text || "Got it! Does everything look right?";
      setReviews(r => ({ ...r, [sectionId]: { status:"reviewing", messages:[{ role:"assistant", content:text }], input:"", loading:false } }));
    } catch {
      setReviews(r => ({ ...r, [sectionId]: { status:"reviewing", messages:[{ role:"assistant", content:"Got it! Does everything look right, or anything to adjust?" }], input:"", loading:false } }));
    }
  }

  // ── Handle reply within a review thread ──────────────────────────────────
  async function handleReviewMessage(sectionId, action, value) {
    if (action === "input") {
      setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], input:value } }));
      return;
    }
    // action === "send"
    const review = reviews[sectionId];
    if (!review.input.trim() || review.loading) return;

    const userMsg = { role:"user", content:review.input.trim() };
    const newMsgs = [...review.messages, userMsg];
    setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], messages:newMsgs, input:"", loading:true } }));

    const data = buildReviewData(sectionId);
    const systemContext = `You are Clearpath, a warm debt payoff assistant reviewing the user's ${sectionId} data. Keep replies brief (2-3 sentences max). Be warm and encouraging. If they say something looks wrong, acknowledge and tell them to edit the form above and click "Review" again. Current data: ${JSON.stringify(data)}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-haiku-4-5-20251001",
          max_tokens:300,
          system: systemContext,
          messages: newMsgs.map(m=>({ role:m.role, content:m.content })),
        }),
      });
      const d = await res.json();
      const reply = d.content?.[0]?.text || "Sounds good!";
      setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], messages:[...newMsgs,{ role:"assistant", content:reply }], loading:false } }));
    } catch {
      setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], messages:[...newMsgs,{ role:"assistant", content:"Got it! Feel free to continue." }], loading:false } }));
    }
  }

  function confirmSection(sectionId) {
    setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], status:"confirmed" } }));
    const idx = SECTIONS.findIndex(s => s.id === sectionId);
    if (idx < SECTIONS.length - 1) setOpenSection(SECTIONS[idx+1].id);
  }

  function editSection(sectionId) {
    setReviews(r => ({ ...r, [sectionId]: { ...emptyReview } }));
    setOpenSection(sectionId);
  }

  // ── Full payload for plan generation ─────────────────────────────────────
  function buildPayload() {
    const f = form;
    const extraIncomeTotal = f.extra_income.reduce((a,v)=>a+(parseFloat(v.amount)||0),0);
    const monthlyIn = [f.monthly_takehome,f.partner_income,f.other_income].reduce((a,v)=>a+(parseFloat(v)||0),0)+extraIncomeTotal;
    const regularExp = [
      ["Rent/Mortgage",f.rent_mortgage],["Property Tax",f.property_tax],["HOA",f.hoa],
      ["Electric/Gas",f.electric_gas],["Water",f.water],["Internet",f.internet],
      ["Streaming",f.streaming],["Phone",f.phone],["Car Payment",f.car_payment],
      ["Car Insurance (monthly)",f.car_insurance_monthly],["Gas",f.gas],
      ["Groceries",f.groceries],["Dining Out",f.dining],
      ["Health Insurance",f.health_insurance],["Medical Copays",f.medical_copays],
      ["Childcare",f.childcare],["Pets",f.pets],["Personal Care",f.personal_care],
      ["Gym",f.gym],["Savings Transfers",f.savings_transfers],
      ["Misc Buffer",f.misc_buffer],["Other Monthly",f.other_monthly],
    ].map(([name,v])=>({name,amount:parseFloat(v)||0})).filter(e=>e.amount>0)
      .concat(f.extra_monthly.filter(e=>e.name&&parseFloat(e.amount)>0).map(e=>({name:e.name,amount:parseFloat(e.amount)})));

    const irregularAnn = [
      ["Car Insurance (annual)",f.car_insurance_annual],
      ["Home Insurance (annual)",f.home_insurance_annual],
      ["Memberships/Amazon",f.amazon_prime],["Car Registration",f.car_registration],
      ["Vet Bills",f.vet_annual],["Holiday Spending",f.holiday_spending],
      ["Vacation",f.vacation_annual],["Other Annual",f.other_irregular],
    ].map(([name,v])=>({name,amount:parseFloat(v)||0})).filter(e=>e.amount>0)
      .concat(f.extra_annual.filter(e=>e.name&&parseFloat(e.amount)>0).map(e=>({name:e.name,amount:parseFloat(e.amount)})));

    const monthlyIrreg = irregularAnn.reduce((a,e)=>a+e.amount,0)/12;
    const totalExp = regularExp.reduce((a,e)=>a+e.amount,0)+monthlyIrreg;
    const totalMins = f.debts.reduce((a,d)=>a+(parseFloat(d.min)||0),0);
    const committed = parseFloat(f.monthly_committed)||0;

    return {
      name: f.name||"there",
      today: new Date().toLocaleDateString("en-US",{month:"long",year:"numeric"}),
      income: { monthly_takehome:parseFloat(f.monthly_takehome)||0, partner:parseFloat(f.partner_income)||0, other:parseFloat(f.other_income)||0, extra:f.extra_income.filter(e=>e.name).map(e=>({name:e.name,amount:parseFloat(e.amount)||0})), total:monthlyIn, gross_annual:parseFloat(f.gross_annual)||0, bonus_amount:parseFloat(f.bonus_amount)||0, bonus_month:f.bonus_month },
      expenses: { regular:regularExp, irregular_annual:irregularAnn, monthly_irregular_equiv:Math.round(monthlyIrreg), total_monthly:Math.round(totalExp) },
      surplus: Math.round(monthlyIn-totalExp),
      debts: f.debts.map(d=>({
        name:d.name, balance:parseFloat(d.balance)||0, rate:(parseFloat(d.rate)||0)/100, min:parseFloat(d.min)||0, type:d.type,
        deferred_until: d.deferred&&d.deferred_until_month&&d.deferred_until_year?{month:parseInt(d.deferred_until_month),year:parseInt(d.deferred_until_year)}:null,
        is_heloc_io:d.is_heloc_io,
        heloc_draw_ends: d.is_heloc_io&&d.heloc_draw_ends_month?{month:parseInt(d.heloc_draw_ends_month),year:parseInt(d.heloc_draw_ends_year)}:null,
      })),
      total_debt: f.debts.reduce((a,d)=>a+(parseFloat(d.balance)||0),0),
      total_minimums: Math.round(totalMins),
      monthly_committed: committed,
      extra_monthly: Math.round(Math.max(0,committed-totalMins)),
      goals: { priority:f.priority, emergency_fund_current:parseFloat(f.emergency_fund_current)||0, emergency_fund_target:parseFloat(f.emergency_fund_target)||0, open_to_refi:f.open_to_refi, emotional_priority:f.emotional_priority, upcoming_expenses:f.upcoming_expenses },
    };
  }

  async function generatePlan() {
    if (!form.debts.length) { setPlanError("Add at least one debt first."); return; }
    if (!form.monthly_committed) { setPlanError("Enter your monthly commitment in Goals."); return; }
    setPlanLoading(true); setPlanError(""); setPlanText("");
    try {
      const payload = buildPayload();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-haiku-4-5-20251001",
          max_tokens:2000,
          system:PLAN_SYSTEM_PROMPT,
          messages:[{ role:"user", content:`Here is my complete financial data. Please generate my three debt payoff plans.\n\n${JSON.stringify(payload,null,2)}` }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message||"API error");
      setPlanText(data.content?.[0]?.text||"");
      setQaMessages([{ role:"assistant", content:`Hi ${form.name||"there"}! Your plan is ready. I have all your numbers in front of me — ask me anything, run a what-if, or ask me to explain any term.` }]);
      setScreen("plan");
    } catch(e) { setPlanError("Error: "+e.message); }
    finally { setPlanLoading(false); }
  }

  async function sendQA() {
    if (!qaInput.trim()||qaLoading) return;
    const msg = { role:"user", content:qaInput.trim() };
    const msgs = [...qaMessages,msg];
    setQaMessages(msgs); setQaInput(""); setQaLoading(true);
    const payload = buildPayload();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-haiku-4-5-20251001",
          max_tokens:800,
          system:`You are an expert debt payoff advisor. Answer questions about the user's plan using their actual data only. Never invent numbers. Today: ${new Date().toLocaleDateString("en-US",{month:"long",year:"numeric"})}.\n\nUSER DATA:\n${JSON.stringify(payload,null,2)}\n\nUSER'S PLAN:\n${planText}`,
          messages:msgs.map(m=>({role:m.role,content:m.content})),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message||"API error");
      setQaMessages(m=>[...m,{ role:"assistant", content:data.content?.[0]?.text||"" }]);
    } catch { setQaMessages(m=>[...m,{ role:"assistant", content:"Sorry, hit an error. Please try again." }]); }
    finally { setQaLoading(false); }
  }

  const totalDebt = form.debts.reduce((a,d)=>a+(parseFloat(d.balance)||0),0);
  const totalMins = form.debts.reduce((a,d)=>a+(parseFloat(d.min)||0),0);

  function renderMd(text) {
    if (!text) return null;
    return text.split("\n").map((line,i) => {
      if (line.startsWith("### ")) return <h3 key={i} style={{ color:"#38bdf8", fontSize:15, fontWeight:700, margin:"18px 0 6px" }}>{line.slice(4)}</h3>;
      if (line.startsWith("## ")) return <h2 key={i} style={{ color:"#f1f5f9", fontSize:17, fontWeight:700, margin:"24px 0 8px", borderBottom:"1px solid #1e293b", paddingBottom:6 }}>{line.slice(3)}</h2>;
      if (line.startsWith("- ")) return <div key={i} style={{ display:"flex", gap:8, color:"#cbd5e1", fontSize:13, lineHeight:1.6, margin:"3px 0 3px 6px" }}><span style={{flexShrink:0}}>•</span><span dangerouslySetInnerHTML={{__html:line.slice(2).replace(/\*\*(.*?)\*\*/g,"<strong style='color:#f1f5f9'>$1</strong>")}} /></div>;
      if (line==="---") return <hr key={i} style={{ border:"none", borderTop:"1px solid #1e293b", margin:"18px 0" }} />;
      if (!line.trim()) return <div key={i} style={{ height:5 }} />;
      return <p key={i} style={{ color:"#94a3b8", fontSize:13, lineHeight:1.7, margin:"3px 0" }} dangerouslySetInnerHTML={{__html:line.replace(/\*\*(.*?)\*\*/g,"<strong style='color:#e2e8f0'>$1</strong>")}} />;
    });
  }

  const headerStyle = { background:"#0f172a", borderBottom:"1px solid #1e293b", padding:"14px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:100 };
  const logoBlock = (
    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
      <div style={{ width:30, height:30, borderRadius:8, background:"linear-gradient(135deg,#1A7A6E,#22a89a)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>🧭</div>
      <span style={{ fontSize:15, fontWeight:800, color:"#f1f5f9", letterSpacing:"-0.02em" }}>CLEARPATH</span>
    </div>
  );

  // ── CODE SCREEN ───────────────────────────────────────────────────────────
  if (screen==="code") return (
    <div style={{ minHeight:"100vh", background:"#0a0f1a", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',system-ui,sans-serif", padding:24 }}>
      <div style={{ width:"100%", maxWidth:420 }}>
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:10, marginBottom:20 }}>
            <div style={{ width:44, height:44, borderRadius:12, background:"linear-gradient(135deg,#1A7A6E,#22a89a)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🧭</div>
            <span style={{ fontSize:24, fontWeight:800, color:"#f1f5f9", letterSpacing:"-0.03em" }}>CLEARPATH</span>
          </div>
          <h1 style={{ fontSize:26, fontWeight:700, color:"#f1f5f9", margin:"0 0 8px", letterSpacing:"-0.02em" }}>Your Debt-Free Roadmap</h1>
          <p style={{ color:"#475569", fontSize:14 }}>Enter your access code to get started</p>
        </div>
        <div style={{ background:"#0f172a", borderRadius:16, border:"1px solid #1e293b", padding:28 }}>
          <label style={labelStyle}>Access Code</label>
          <input value={code} onChange={e=>setCode(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleValidateCode()} placeholder="CLEAR-XXXX-XXXX" style={{ ...inputStyle, fontSize:16, letterSpacing:"0.05em", fontFamily:"monospace", marginBottom:4 }} />
          {codeError && <p style={{ color:"#f87171", fontSize:13, margin:"6px 0 10px" }}>{codeError}</p>}
          <button onClick={handleValidateCode} disabled={codeLoading||!code.trim()} style={{ width:"100%", marginTop:14, background:"linear-gradient(135deg,#1A7A6E,#22a89a)", color:"white", border:"none", borderRadius:10, padding:14, fontSize:15, fontWeight:600, cursor:"pointer" }}>
            {codeLoading?"Checking…":"Unlock My Plan →"}
          </button>
        </div>
        <p style={{ textAlign:"center", color:"#1e293b", fontSize:11, marginTop:16 }}>Not financial advice · Plans based on your inputs</p>
      </div>
    </div>
  );

  // ── FORM SCREEN ───────────────────────────────────────────────────────────
  if (screen==="form") {
    // Which sections are confirmed
    const confirmed = sectionId => reviews[sectionId]?.status === "confirmed";
    const reviewing = sectionId => reviews[sectionId]?.status === "reviewing";
    // A section is unlocked if it's the first, or the previous section is confirmed
    const isUnlocked = (sectionId) => {
      const idx = SECTIONS.findIndex(s=>s.id===sectionId);
      if (idx===0) return true;
      return confirmed(SECTIONS[idx-1].id);
    };

    const sectionForms = {
      intro: (
        <>
          <p style={{ color:"#64748b", fontSize:14, lineHeight:1.7, marginBottom:16 }}>Fill out each section below. <strong style={{color:"#f1f5f9"}}>Estimates are completely fine.</strong></p>
          <Field form={form} setField={setField} label="Your first name" name="name" placeholder="What should I call you?" />
          {!reviewing("intro") && !confirmed("intro") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("intro")} disabled={!form.name.trim()} style={{ background:!form.name.trim()?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:!form.name.trim()?"#334155":"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:!form.name.trim()?"not-allowed":"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
      income: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:16 }}>Take-home = what lands in your bank after taxes.</p>
          <Field form={form} setField={setField} label="Your monthly take-home pay" name="monthly_takehome" prefix="$" placeholder="3,500" hint="After taxes — what actually hits your account" />
          <Row2>
            <Field form={form} setField={setField} label="Partner take-home (if any)" name="partner_income" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Other regular monthly income" name="other_income" prefix="$" placeholder="0" hint="Rental, freelance, etc." />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Gross annual household salary" name="gross_annual" prefix="$" placeholder="75,000" hint="Before tax, rough is fine" />
            <Field form={form} setField={setField} label="Annual bonus (if any)" name="bonus_amount" prefix="$" placeholder="0" />
          </Row2>
          <Field form={form} setField={setField} label="Bonus arrival month (if applicable)" name="bonus_month" placeholder="e.g. March" hint="Applied as a lump sum in that month" />
          <Divider label="Additional Income Sources" />
          <ExtraItems listKey="extra_income" items={form.extra_income} prefix="$" addItem={addItem} updateItem={updateItem} removeItem={removeItem} addLabel="+ Add income source" />
          {!reviewing("income") && !confirmed("income") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("income")} disabled={!form.monthly_takehome} style={{ background:!form.monthly_takehome?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:!form.monthly_takehome?"#334155":"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:!form.monthly_takehome?"not-allowed":"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
      expenses_regular: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Monthly recurring only. If you pay car insurance every 6 months, enter it in Annual Expenses.</p>
          <Divider label="Housing" />
          <Row2>
            <Field form={form} setField={setField} label="Rent or mortgage" name="rent_mortgage" prefix="$" placeholder="1,200" />
            <Field form={form} setField={setField} label="Property tax (direct only)" name="property_tax" prefix="$" placeholder="0" />
          </Row2>
          <Row2><Field form={form} setField={setField} label="HOA fees" name="hoa" prefix="$" placeholder="0" /></Row2>
          <Divider label="Utilities & Services" />
          <Row2>
            <Field form={form} setField={setField} label="Electric / gas" name="electric_gas" prefix="$" placeholder="120" />
            <Field form={form} setField={setField} label="Water / sewer" name="water" prefix="$" placeholder="50" />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Internet" name="internet" prefix="$" placeholder="65" />
            <Field form={form} setField={setField} label="Cell phone" name="phone" prefix="$" placeholder="80" />
          </Row2>
          <Field form={form} setField={setField} label="Streaming & subscriptions (total)" name="streaming" prefix="$" placeholder="45" />
          <Divider label="Transportation" />
          <Row2>
            <Field form={form} setField={setField} label="Car payment(s)" name="car_payment" prefix="$" placeholder="0" hint="Loan/lease only — not insurance" />
            <Field form={form} setField={setField} label="Car insurance (if monthly)" name="car_insurance_monthly" prefix="$" placeholder="0" hint="Skip if you pay annually" />
          </Row2>
          <Field form={form} setField={setField} label="Gas" name="gas" prefix="$" placeholder="120" />
          <Divider label="Food" />
          <Row2>
            <Field form={form} setField={setField} label="Groceries" name="groceries" prefix="$" placeholder="400" />
            <Field form={form} setField={setField} label="Dining out / takeout" name="dining" prefix="$" placeholder="200" />
          </Row2>
          <Divider label="Health & Insurance" />
          <Row2>
            <Field form={form} setField={setField} label="Health insurance (out of pocket)" name="health_insurance" prefix="$" placeholder="0" hint="Skip if pre-tax from paycheck" />
            <Field form={form} setField={setField} label="Medical copays / prescriptions" name="medical_copays" prefix="$" placeholder="30" />
          </Row2>
          <Divider label="Family & Personal" />
          <Row2>
            <Field form={form} setField={setField} label="Childcare / tuition" name="childcare" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Pets (food, meds, grooming)" name="pets" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Personal care (haircuts etc)" name="personal_care" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Gym / fitness" name="gym" prefix="$" placeholder="0" />
          </Row2>
          <Divider label="Savings & Misc" />
          <Row2>
            <Field form={form} setField={setField} label="Auto savings transfers" name="savings_transfers" prefix="$" placeholder="0" hint="Out of pocket only" />
            <Field form={form} setField={setField} label="Monthly buffer / misc" name="misc_buffer" prefix="$" placeholder="100" />
          </Row2>
          <Field form={form} setField={setField} label="Anything else monthly" name="other_monthly" prefix="$" placeholder="0" hint="Storage, donations, union dues, etc." />
          <Divider label="Custom Monthly Expenses" />
          <ExtraItems listKey="extra_monthly" items={form.extra_monthly} prefix="$" addItem={addItem} updateItem={updateItem} removeItem={removeItem} addLabel="+ Add monthly expense" />
          {!reviewing("expenses_regular") && !confirmed("expenses_regular") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("expenses_regular")} style={{ background:"linear-gradient(135deg,#1A7A6E,#22a89a)", color:"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
      expenses_irregular: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Enter annual totals — divided by 12 for your plan. This is where most plans go wrong.</p>
          <Row2>
            <Field form={form} setField={setField} label="Car insurance (annual total)" name="car_insurance_annual" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Home / renters insurance" name="home_insurance_annual" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Amazon Prime / memberships" name="amazon_prime" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Car registration / inspection" name="car_registration" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Vet bills (annual estimate)" name="vet_annual" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Holiday / gift spending" name="holiday_spending" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field form={form} setField={setField} label="Vacation / travel" name="vacation_annual" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Other annual costs" name="other_irregular" prefix="$" placeholder="0" />
          </Row2>
          <Divider label="Custom Annual Expenses" />
          <ExtraItems listKey="extra_annual" items={form.extra_annual} prefix="$" addItem={addItem} updateItem={updateItem} removeItem={removeItem} addLabel="+ Add annual expense" />
          {!reviewing("expenses_irregular") && !confirmed("expenses_irregular") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("expenses_irregular")} style={{ background:"linear-gradient(135deg,#1A7A6E,#22a89a)", color:"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
      debts: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Add every debt. Use whatever name makes sense to you. Estimates are fine.</p>
          {form.debts.map((debt,idx) => (
            <div key={debt.id||idx} style={{ background:"#0a0f1a", borderRadius:12, border:"1px solid #1e293b", padding:18, marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <span style={{ fontSize:12, fontWeight:700, color:"#22a89a", textTransform:"uppercase", letterSpacing:"0.05em" }}>Debt #{idx+1}</span>
                <button onClick={()=>removeDebt(idx)} style={{ background:"none", border:"none", color:"#334155", cursor:"pointer", fontSize:16 }}>✕</button>
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={labelStyle}>Name this debt</label>
                <input value={debt.name} onChange={e=>updateDebt(idx,"name",e.target.value)} placeholder='"My Chase card" or "Student loan"' style={inputStyle} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:12 }}>
                {[["Balance","balance","$","","5,000"],["Interest Rate %","rate","","% APR","19.99"],["Min Payment","min","$","","100"]].map(([label,key,pre,suf,ph])=>(
                  <div key={key}>
                    <label style={labelStyle}>{label}</label>
                    <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:7, border:"1px solid #334155", overflow:"hidden" }}>
                      {pre&&<span style={{ padding:"0 8px", color:"#475569", fontSize:12 }}>{pre}</span>}
                      <input value={debt[key]} onChange={e=>updateDebt(idx,key,e.target.value)} placeholder={ph} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:13, padding:"9px 6px" }} />
                      {suf&&<span style={{ padding:"0 8px", color:"#475569", fontSize:11 }}>{suf}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={labelStyle}>Type</label>
                <select value={debt.type} onChange={e=>updateDebt(idx,"type",e.target.value)} style={{ ...inputStyle, padding:"9px 12px" }}>
                  {DEBT_TYPES.map(t=><option key={t} value={t}>{t.replace("_"," ").replace(/\b\w/g,c=>c.toUpperCase())}</option>)}
                </select>
              </div>
              <div style={{ display:"flex", gap:20 }}>
                <label style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:12, cursor:"pointer" }}>
                  <input type="checkbox" checked={debt.deferred} onChange={e=>updateDebt(idx,"deferred",e.target.checked)} /> Currently deferred?
                </label>
                <label style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:12, cursor:"pointer" }}>
                  <input type="checkbox" checked={debt.is_heloc_io} onChange={e=>updateDebt(idx,"is_heloc_io",e.target.checked)} /> HELOC interest-only?
                </label>
              </div>
              {debt.deferred && (
                <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <div><label style={labelStyle}>Repayment starts — Month #</label><input value={debt.deferred_until_month} onChange={e=>updateDebt(idx,"deferred_until_month",e.target.value)} placeholder="9" style={inputStyle} /></div>
                  <div><label style={labelStyle}>Year</label><input value={debt.deferred_until_year} onChange={e=>updateDebt(idx,"deferred_until_year",e.target.value)} placeholder="2027" style={inputStyle} /></div>
                </div>
              )}
              {debt.is_heloc_io && (
                <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  <div><label style={labelStyle}>Draw period ends — Month #</label><input value={debt.heloc_draw_ends_month} onChange={e=>updateDebt(idx,"heloc_draw_ends_month",e.target.value)} placeholder="6" style={inputStyle} /></div>
                  <div><label style={labelStyle}>Year</label><input value={debt.heloc_draw_ends_year} onChange={e=>updateDebt(idx,"heloc_draw_ends_year",e.target.value)} placeholder="2026" style={inputStyle} /></div>
                </div>
              )}
            </div>
          ))}
          <button onClick={addDebt} style={{ width:"100%", background:"transparent", border:"2px dashed #1e293b", borderRadius:10, color:"#334155", fontSize:13, fontWeight:600, padding:13, cursor:"pointer" }}
            onMouseEnter={e=>{e.target.style.borderColor="#22a89a";e.target.style.color="#22a89a";}}
            onMouseLeave={e=>{e.target.style.borderColor="#1e293b";e.target.style.color="#334155";}}>
            + Add a Debt
          </button>
          {form.debts.length>0 && (
            <div style={{ marginTop:14, padding:14, background:"#0a0f1a", borderRadius:10, border:"1px solid #1e293b", display:"flex", gap:20 }}>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Total Debt</span><span style={{ fontSize:18, fontWeight:700, color:"#f87171" }}>${totalDebt.toLocaleString()}</span></div>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Min Payments/mo</span><span style={{ fontSize:18, fontWeight:700, color:"#fbbf24" }}>${totalMins.toLocaleString()}</span></div>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Debts</span><span style={{ fontSize:18, fontWeight:700, color:"#22a89a" }}>{form.debts.length}</span></div>
            </div>
          )}
          {!reviewing("debts") && !confirmed("debts") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("debts")} disabled={form.debts.length===0} style={{ background:form.debts.length===0?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:form.debts.length===0?"#334155":"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:form.debts.length===0?"not-allowed":"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
      goals: (
        <>
          <div style={{ marginBottom:18 }}>
            <label style={labelStyle}>Your #1 priority</label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {PRIORITIES.map(p=>(
                <button key={p.value} onClick={()=>setField("priority",p.value)} style={{ padding:"12px 14px", borderRadius:9, border:`2px solid ${form.priority===p.value?"#22a89a":"#1e293b"}`, background:form.priority===p.value?"rgba(26,122,110,0.12)":"#0f172a", color:form.priority===p.value?"#22a89a":"#475569", textAlign:"left", cursor:"pointer" }}>
                  <div style={{ fontWeight:700, fontSize:12, marginBottom:2 }}>{p.label}</div>
                  <div style={{ fontSize:11 }}>{p.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div style={{ background:"#0a0f1a", borderRadius:10, border:"1px solid #1e293b", padding:16, marginBottom:16 }}>
            <label style={labelStyle}>Monthly commitment to debt payoff</label>
            {totalMins>0 && <p style={{ color:"#475569", fontSize:12, marginBottom:10 }}>Your minimums total <strong style={{color:"#fbbf24"}}>${totalMins.toLocaleString()}/mo</strong>. Any amount above that accelerates your plan.</p>}
            <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:8, border:"1px solid #334155", overflow:"hidden" }}>
              <span style={{ padding:"0 10px", color:"#475569", fontSize:14, borderRight:"1px solid #334155", lineHeight:"40px" }}>$</span>
              <input value={form.monthly_committed} onChange={e=>setField("monthly_committed",e.target.value)} placeholder={totalMins?`${totalMins} min, more = faster`:"e.g. 800"} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:14, padding:"0 12px", height:40 }} />
              <span style={{ padding:"0 10px", color:"#475569", fontSize:12 }}>/mo</span>
            </div>
          </div>
          <Row2>
            <Field form={form} setField={setField} label="Emergency fund (current)" name="emergency_fund_current" prefix="$" placeholder="0" />
            <Field form={form} setField={setField} label="Emergency fund (target)" name="emergency_fund_target" prefix="$" placeholder="10,000" />
          </Row2>
          <label style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:13, cursor:"pointer", marginBottom:14 }}>
            <input type="checkbox" checked={form.open_to_refi} onChange={e=>setField("open_to_refi",e.target.checked)} /> Open to refinancing if it saves meaningful money
          </label>
          <Field form={form} setField={setField} label="Any debt you especially want gone first?" name="emotional_priority" placeholder='e.g. "my Discover card"' hint="Optional — we'll factor in emotional priorities" />
          <Field form={form} setField={setField} label="Big upcoming expenses in the next 1–2 years?" name="upcoming_expenses" placeholder="Wedding, renovation, new baby…" hint="Optional" />
          {!reviewing("goals") && !confirmed("goals") && (
            <div style={{ textAlign:"right", marginTop:20 }}>
              <button onClick={()=>startReview("goals")} disabled={!form.monthly_committed} style={{ background:!form.monthly_committed?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:!form.monthly_committed?"#334155":"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:!form.monthly_committed?"not-allowed":"pointer" }}>
                Submit for Review →
              </button>
            </div>
          )}
        </>
      ),
    };

    return (
      <div style={{ minHeight:"100vh", background:"#0a0f1a", fontFamily:"'Inter',system-ui,sans-serif" }}>
        <div style={headerStyle}>
          {logoBlock}
          {form.name && <span style={{ color:"#334155", fontSize:13 }}>Hi, {form.name} 👋</span>}
        </div>
        <div style={{ maxWidth:680, margin:"0 auto", padding:"28px 24px 80px" }}>
          <div style={{ marginBottom:28 }}>
            <h1 style={{ fontSize:24, fontWeight:700, color:"#f1f5f9", letterSpacing:"-0.02em", margin:"0 0 6px" }}>Build Your Debt-Free Plan</h1>
            <p style={{ color:"#334155", fontSize:13 }}>Complete each section in order. Clearpath reviews your info before you move on.</p>
          </div>

          {SECTIONS.map((sec,secIdx) => {
            const isOpen = openSection===sec.id;
            const isDone = confirmed(sec.id);
            const isLocked = !isUnlocked(sec.id);
            const rev = reviews[sec.id];

            return (
              <div key={sec.id} style={{ marginBottom:10, borderRadius:12, border:`1px solid ${isOpen?"#22a89a":isDone?"#1e3a34":isLocked?"#111827":"#1e293b"}`, overflow:"hidden", opacity:isLocked?0.45:1 }}>
                <button
                  onClick={()=>{ if(!isLocked) setOpenSection(isOpen?null:sec.id); }}
                  disabled={isLocked}
                  style={{ width:"100%", background:isOpen?"#0d2420":isDone?"#0a1f1c":"#0f172a", border:"none", padding:"16px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:isLocked?"not-allowed":"pointer" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:18 }}>{isDone?"✅":isLocked?"🔒":sec.icon}</span>
                    <span style={{ fontSize:14, fontWeight:600, color:isOpen?"#22a89a":isDone?"#4ade80":isLocked?"#1e293b":"#64748b" }}>{sec.label}</span>
                  </div>
                  {!isLocked && <span style={{ color:"#334155", fontSize:11, transform:isOpen?"rotate(180deg)":"none", transition:"transform 0.2s" }}>▼</span>}
                  {isLocked && <span style={{ color:"#1e293b", fontSize:11 }}>Complete previous section first</span>}
                </button>

                {isOpen && (
                  <div style={{ background:"#0f172a", padding:"20px 20px 6px", borderTop:"1px solid #1e293b" }}>
                    {/* Show form if not confirmed, or if editing */}
                    {!isDone && sectionForms[sec.id]}

                    {/* Show review panel once submitted */}
                    {(rev.status==="reviewing"||rev.status==="confirmed") && (
                      <ReviewPanel
                        sectionId={sec.id}
                        review={rev}
                        onSendMessage={handleReviewMessage}
                        onConfirm={()=>confirmSection(sec.id)}
                        onEdit={()=>editSection(sec.id)}
                      />
                    )}

                    {/* Confirmed: show collapsed form summary + edit option */}
                    {isDone && (
                      <div style={{ paddingBottom:14 }}>
                        <p style={{ color:"#334155", fontSize:12, marginBottom:10 }}>This section is confirmed. The review is visible above.</p>
                        <ReviewPanel
                          sectionId={sec.id}
                          review={rev}
                          onSendMessage={handleReviewMessage}
                          onConfirm={()=>confirmSection(sec.id)}
                          onEdit={()=>editSection(sec.id)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Generate */}
          <div style={{ marginTop:28, background:"#0f172a", borderRadius:14, border:"1px solid #1e3a34", padding:24, textAlign:"center" }}>
            <h2 style={{ fontSize:18, fontWeight:700, color:"#f1f5f9", margin:"0 0 6px" }}>Ready to see your plan?</h2>
            {totalDebt>0 && <p style={{ color:"#334155", fontSize:13, margin:"0 0 18px" }}>{form.debts.length} debt{form.debts.length!==1?"s":""} · <span style={{color:"#f87171"}}>${totalDebt.toLocaleString()}</span> · <span style={{color:"#22a89a"}}>${parseFloat(form.monthly_committed||0).toLocaleString()}/mo</span></p>}
            {planError && <p style={{ color:"#f87171", fontSize:13, marginBottom:14 }}>{planError}</p>}
            <button onClick={generatePlan} disabled={planLoading||!form.debts.length||!form.monthly_committed} style={{ background:planLoading||!form.debts.length||!form.monthly_committed?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:planLoading||!form.debts.length||!form.monthly_committed?"#334155":"white", border:"none", borderRadius:10, padding:"14px 36px", fontSize:15, fontWeight:700, cursor:"pointer", boxShadow:"0 4px 20px rgba(26,122,110,0.25)" }}>
              {planLoading?"⏳ Calculating your plan…":"🧭 Generate My Debt-Free Plan →"}
            </button>
            {(!form.debts.length||!form.monthly_committed) && <p style={{ color:"#334155", fontSize:11, marginTop:8 }}>{!form.debts.length?"Add at least one debt first":"Enter your monthly commitment in Goals"}</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── PLAN SCREEN ───────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#0a0f1a", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={headerStyle}>
        {logoBlock}
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={()=>setScreen("form")} style={{ background:"transparent", border:"1px solid #1e293b", borderRadius:7, color:"#475569", fontSize:12, padding:"7px 14px", cursor:"pointer" }}>← Edit</button>
          <button onClick={async()=>{
            try {
              const res = await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(buildPayload())});
              if(!res.ok) throw new Error();
              const blob = await res.blob();
              const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
              a.download=`Clearpath_${form.name||"Plan"}.xlsx`; a.click();
            } catch { alert("Error generating Excel. Please try again."); }
          }} style={{ background:"linear-gradient(135deg,#C8963E,#e8b86d)", color:"#0a0f1a", border:"none", borderRadius:7, fontSize:12, fontWeight:700, padding:"7px 14px", cursor:"pointer" }}>
            ⬇ Excel
          </button>
        </div>
      </div>
      <div style={{ maxWidth:860, margin:"0 auto", padding:"28px 20px 80px", display:"grid", gridTemplateColumns:"1fr 360px", gap:24, alignItems:"start" }}>
        <div style={{ background:"#0f172a", borderRadius:14, border:"1px solid #1e293b", padding:28 }}>
          <div style={{ marginBottom:20, paddingBottom:16, borderBottom:"1px solid #1e293b" }}>
            <h1 style={{ fontSize:20, fontWeight:700, color:"#f1f5f9", margin:"0 0 4px", letterSpacing:"-0.02em" }}>{form.name?`${form.name}'s Plan`:"Your Debt-Free Plan"}</h1>
            <div style={{ display:"flex", gap:16 }}>
              <span style={{ fontSize:12, color:"#f87171" }}>{form.debts.length} debts · ${totalDebt.toLocaleString()}</span>
              <span style={{ fontSize:12, color:"#22a89a" }}>${parseFloat(form.monthly_committed||0).toLocaleString()}/mo</span>
            </div>
          </div>
          <div>{renderMd(planText)}</div>
        </div>
        <div style={{ position:"sticky", top:68 }}>
          <div style={{ background:"#0f172a", borderRadius:14, border:"1px solid #1e293b", overflow:"hidden" }}>
            <div style={{ padding:"14px 18px", borderBottom:"1px solid #1e293b", background:"#0d2420" }}>
              <h3 style={{ margin:0, fontSize:13, fontWeight:700, color:"#22a89a" }}>💬 Ask Me Anything</h3>
              <p style={{ margin:"3px 0 0", fontSize:11, color:"#334155" }}>What-ifs · explanations · next steps</p>
            </div>
            <div style={{ height:340, overflowY:"auto", padding:14, display:"flex", flexDirection:"column", gap:10 }}>
              {qaMessages.map((m,i)=>(
                <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                  <div style={{ maxWidth:"90%", padding:"9px 13px", borderRadius:m.role==="user"?"12px 12px 3px 12px":"12px 12px 12px 3px", background:m.role==="user"?"linear-gradient(135deg,#1A7A6E,#22a89a)":"#1e293b", color:"#f1f5f9", fontSize:12, lineHeight:1.6 }}>{m.content}</div>
                </div>
              ))}
              {qaLoading&&<div style={{display:"flex"}}><div style={{background:"#1e293b",borderRadius:"12px 12px 12px 3px",padding:"9px 13px"}}><span style={{color:"#334155",fontSize:12}}>Thinking…</span></div></div>}
              <div ref={qaEndRef} />
            </div>
            <div style={{ padding:10, borderTop:"1px solid #1e293b" }}>
              <div style={{ display:"flex", gap:7 }}>
                <input value={qaInput} onChange={e=>setQaInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendQA()} placeholder="Ask a question…" style={{ flex:1, background:"#1e293b", border:"1px solid #334155", borderRadius:7, color:"#f1f5f9", fontSize:12, padding:"9px 11px", outline:"none" }} />
                <button onClick={sendQA} disabled={qaLoading||!qaInput.trim()} style={{ background:"linear-gradient(135deg,#1A7A6E,#22a89a)", border:"none", borderRadius:7, padding:"9px 13px", cursor:"pointer", color:"white", fontSize:13 }}>→</button>
              </div>
            </div>
          </div>
          <div style={{ marginTop:10, display:"flex", flexDirection:"column", gap:5 }}>
            {["What should I do first this month?","What if I get a $3,000 bonus?","Explain the avalanche method"].map(q=>(
              <button key={q} onClick={()=>setQaInput(q)} style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:7, color:"#334155", fontSize:11, padding:"7px 11px", cursor:"pointer", textAlign:"left" }}
                onMouseEnter={e=>{e.target.style.color="#22a89a";e.target.style.borderColor="#22a89a";}}
                onMouseLeave={e=>{e.target.style.color="#334155";e.target.style.borderColor="#1e293b";}}>{q}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

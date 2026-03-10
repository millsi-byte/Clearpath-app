import { useState, useEffect, useRef } from "react";

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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

export default function App() {
  const [screen, setScreen] = useState("code");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [sessionRow, setSessionRow] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [openSection, setOpenSection] = useState("intro");
  const [completedSections, setCompletedSections] = useState(new Set());
  const [planLoading, setPlanLoading] = useState(false);
  const [planText, setPlanText] = useState("");
  const [planError, setPlanError] = useState("");
  const [qaMessages, setQaMessages] = useState([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaEndRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => { qaEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [qaMessages]);

  useEffect(() => {
    if (!sessionRow) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      sbFetch(`access_codes?id=eq.${sessionRow.id}`, {
        method: "PATCH",
        body: JSON.stringify({ session_data: { form, planText, qaMessages } }),
      });
    }, 2000);
    return () => clearTimeout(saveTimer.current);
  }, [form, planText, qaMessages]);

  async function handleValidateCode() {
    if (!code.trim()) return;
    setCodeLoading(true); setCodeError("");
    try {
      const res = await fetch("/api/validate-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      const data = await res.json();
      if (!res.ok) { setCodeError(data.error || "Invalid code"); return; }
      setSessionRow(data.row);
      if (data.row.session_data?.planText) {
        setForm(data.row.session_data.form || emptyForm);
        setPlanText(data.row.session_data.planText || "");
        setQaMessages(data.row.session_data.qaMessages || []);
        setScreen("plan");
      } else if (data.row.session_data?.form) {
        setForm(data.row.session_data.form);
        setScreen("form");
      } else {
        setScreen("form");
      }
    } catch { setCodeError("Connection error. Try again."); }
    finally { setCodeLoading(false); }
  }

  const setField = (key, val) => setForm(f => ({ ...f, [key]: val }));

  function addDebt() {
    setForm(f => ({ ...f, debts: [...f.debts, { ...emptyDebt, id: Date.now() }] }));
  }
  function updateDebt(idx, key, val) {
    setForm(f => { const d = [...f.debts]; d[idx] = { ...d[idx], [key]: val }; return { ...f, debts: d }; });
  }
  function removeDebt(idx) {
    setForm(f => ({ ...f, debts: f.debts.filter((_, i) => i !== idx) }));
  }
  function markComplete(sectionId) {
    setCompletedSections(s => new Set([...s, sectionId]));
    const idx = SECTIONS.findIndex(s => s.id === sectionId);
    if (idx < SECTIONS.length - 1) setOpenSection(SECTIONS[idx + 1].id);
  }

  function buildPayload() {
    const f = form;
    const monthlyIn = [f.monthly_takehome, f.partner_income, f.other_income].reduce((a, v) => a + (parseFloat(v) || 0), 0);
    const regularExp = [
      ["Rent/Mortgage", f.rent_mortgage], ["Property Tax", f.property_tax], ["HOA", f.hoa],
      ["Electric/Gas", f.electric_gas], ["Water", f.water], ["Internet", f.internet],
      ["Streaming", f.streaming], ["Phone", f.phone], ["Car Payment", f.car_payment],
      ["Car Insurance (monthly)", f.car_insurance_monthly], ["Gas", f.gas],
      ["Groceries", f.groceries], ["Dining Out", f.dining],
      ["Health Insurance", f.health_insurance], ["Medical Copays", f.medical_copays],
      ["Childcare", f.childcare], ["Pets", f.pets], ["Personal Care", f.personal_care],
      ["Gym", f.gym], ["Savings Transfers", f.savings_transfers],
      ["Misc Buffer", f.misc_buffer], ["Other Monthly", f.other_monthly],
    ].map(([name, v]) => ({ name, amount: parseFloat(v) || 0 })).filter(e => e.amount > 0);

    const irregularAnn = [
      ["Car Insurance (annual)", f.car_insurance_annual],
      ["Home Insurance (annual)", f.home_insurance_annual],
      ["Memberships/Amazon", f.amazon_prime], ["Car Registration", f.car_registration],
      ["Vet Bills", f.vet_annual], ["Holiday Spending", f.holiday_spending],
      ["Vacation", f.vacation_annual], ["Other Annual", f.other_irregular],
    ].map(([name, v]) => ({ name, amount: parseFloat(v) || 0 })).filter(e => e.amount > 0);

    const monthlyIrreg = irregularAnn.reduce((a, e) => a + e.amount, 0) / 12;
    const totalExp = regularExp.reduce((a, e) => a + e.amount, 0) + monthlyIrreg;
    const totalMins = f.debts.reduce((a, d) => a + (parseFloat(d.min) || 0), 0);
    const committed = parseFloat(f.monthly_committed) || 0;

    return {
      name: f.name || "there",
      today: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      income: { monthly_takehome: parseFloat(f.monthly_takehome)||0, partner: parseFloat(f.partner_income)||0, other: parseFloat(f.other_income)||0, total: monthlyIn, gross_annual: parseFloat(f.gross_annual)||0, bonus_amount: parseFloat(f.bonus_amount)||0, bonus_month: f.bonus_month },
      expenses: { regular: regularExp, irregular_annual: irregularAnn, monthly_irregular_equiv: Math.round(monthlyIrreg), total_monthly: Math.round(totalExp) },
      surplus: Math.round(monthlyIn - totalExp),
      debts: f.debts.map(d => ({
        name: d.name, balance: parseFloat(d.balance)||0,
        rate: (parseFloat(d.rate)||0) / 100, min: parseFloat(d.min)||0,
        type: d.type,
        deferred_until: d.deferred && d.deferred_until_month && d.deferred_until_year ? { month: parseInt(d.deferred_until_month), year: parseInt(d.deferred_until_year) } : null,
        is_heloc_io: d.is_heloc_io,
        heloc_draw_ends: d.is_heloc_io && d.heloc_draw_ends_month ? { month: parseInt(d.heloc_draw_ends_month), year: parseInt(d.heloc_draw_ends_year) } : null,
      })),
      total_debt: f.debts.reduce((a, d) => a + (parseFloat(d.balance)||0), 0),
      total_minimums: Math.round(totalMins),
      monthly_committed: committed,
      extra_monthly: Math.round(Math.max(0, committed - totalMins)),
      goals: { priority: f.priority, emergency_fund_current: parseFloat(f.emergency_fund_current)||0, emergency_fund_target: parseFloat(f.emergency_fund_target)||0, open_to_refi: f.open_to_refi, emotional_priority: f.emotional_priority, upcoming_expenses: f.upcoming_expenses },
    };
  }

  async function generatePlan() {
    if (!form.debts.length) { setPlanError("Add at least one debt first."); return; }
    if (!form.monthly_committed) { setPlanError("Enter your monthly commitment in Goals."); return; }
    setPlanLoading(true); setPlanError(""); setPlanText("");
    try {
      const payload = buildPayload();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          system: PLAN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: `Here is my complete financial data. Please generate my three debt payoff plans.\n\n${JSON.stringify(payload, null, 2)}` }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "API error");
      setPlanText(data.content?.[0]?.text || "");
      setQaMessages([{ role: "assistant", content: `Hi ${form.name || "there"}! Your plan is ready. I have all your numbers in front of me — ask me anything, run a what-if, or ask me to explain any term.` }]);
      setScreen("plan");
    } catch (e) { setPlanError("Error: " + e.message); }
    finally { setPlanLoading(false); }
  }

  async function sendQA() {
    if (!qaInput.trim() || qaLoading) return;
    const msg = { role: "user", content: qaInput.trim() };
    const msgs = [...qaMessages, msg];
    setQaMessages(msgs); setQaInput(""); setQaLoading(true);
    const payload = buildPayload();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          system: `You are an expert debt payoff advisor. Answer questions about the user's plan using their actual data only. Never invent numbers. Today: ${new Date().toLocaleDateString("en-US",{month:"long",year:"numeric"})}.\n\nUSER DATA:\n${JSON.stringify(payload,null,2)}\n\nUSER'S PLAN:\n${planText}`,
          messages: msgs.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "API error");
      setQaMessages(m => [...m, { role: "assistant", content: data.content?.[0]?.text || "" }]);
    } catch { setQaMessages(m => [...m, { role: "assistant", content: "Sorry, hit an error. Please try again." }]); }
    finally { setQaLoading(false); }
  }

  const totalDebt = form.debts.reduce((a, d) => a + (parseFloat(d.balance)||0), 0);
  const totalMins = form.debts.reduce((a, d) => a + (parseFloat(d.min)||0), 0);

  // Shared styles
  const inputStyle = { width:"100%", background:"#1e293b", border:"1px solid #334155", borderRadius:8, color:"#f1f5f9", fontSize:14, padding:"10px 14px", outline:"none", boxSizing:"border-box" };
  const labelStyle = { display:"block", fontSize:12, fontWeight:600, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:6 };

  function Field({ label, name, placeholder, hint, prefix, suffix, type="text" }) {
    return (
      <div style={{ marginBottom:14 }}>
        <label style={labelStyle}>{label}</label>
        <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:8, border:"1px solid #334155", overflow:"hidden" }}>
          {prefix && <span style={{ padding:"0 10px", color:"#475569", fontSize:14, borderRight:"1px solid #334155", lineHeight:"40px" }}>{prefix}</span>}
          <input type={type} value={form[name]||""} onChange={e=>setField(name,e.target.value)} placeholder={placeholder} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:14, padding:"0 12px", height:40 }} />
          {suffix && <span style={{ padding:"0 10px", color:"#475569", fontSize:12 }}>{suffix}</span>}
        </div>
        {hint && <p style={{ fontSize:11, color:"#334155", marginTop:3 }}>{hint}</p>}
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

  function NextBtn({ sectionId, disabled }) {
    return (
      <div style={{ textAlign:"right", marginTop:20, paddingBottom:4 }}>
        <button onClick={()=>markComplete(sectionId)} disabled={disabled} style={{ background:disabled?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:disabled?"#334155":"white", border:"none", borderRadius:8, padding:"11px 24px", fontSize:13, fontWeight:600, cursor:disabled?"not-allowed":"pointer" }}>
          Save & Continue →
        </button>
      </div>
    );
  }

  function renderMd(text) {
    if (!text) return null;
    return text.split("\n").map((line, i) => {
      if (line.startsWith("### ")) return <h3 key={i} style={{ color:"#38bdf8", fontSize:15, fontWeight:700, margin:"18px 0 6px" }}>{line.slice(4)}</h3>;
      if (line.startsWith("## ")) return <h2 key={i} style={{ color:"#f1f5f9", fontSize:17, fontWeight:700, margin:"24px 0 8px", borderBottom:"1px solid #1e293b", paddingBottom:6 }}>{line.slice(3)}</h2>;
      if (line.startsWith("- ")) return <div key={i} style={{ display:"flex", gap:8, color:"#cbd5e1", fontSize:13, lineHeight:1.6, margin:"3px 0 3px 6px" }}><span style={{flexShrink:0}}>•</span><span dangerouslySetInnerHTML={{__html:line.slice(2).replace(/\*\*(.*?)\*\*/g,"<strong style='color:#f1f5f9'>$1</strong>")}} /></div>;
      if (line === "---") return <hr key={i} style={{ border:"none", borderTop:"1px solid #1e293b", margin:"18px 0" }} />;
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

  // ── CODE SCREEN ─────────────────────────────────────────────────────────
  if (screen === "code") return (
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
            {codeLoading ? "Checking…" : "Unlock My Plan →"}
          </button>
        </div>
        <p style={{ textAlign:"center", color:"#1e293b", fontSize:11, marginTop:16 }}>Not financial advice · Plans based on your inputs</p>
      </div>
    </div>
  );

  // ── FORM SCREEN ─────────────────────────────────────────────────────────
  if (screen === "form") {
    const sectionContent = {
      intro: (
        <>
          <p style={{ color:"#64748b", fontSize:14, lineHeight:1.7, marginBottom:16 }}>Fill out each section below. <strong style={{color:"#f1f5f9"}}>Estimates are completely fine.</strong> You only need your debts and a monthly commitment to generate a plan — everything else improves accuracy.</p>
          <Field label="Your first name" name="name" placeholder="What should I call you?" />
          <NextBtn sectionId="intro" />
        </>
      ),
      income: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:16 }}>Take-home = what lands in your bank after taxes. Don't include gross salary here.</p>
          <Field label="Your monthly take-home pay" name="monthly_takehome" prefix="$" placeholder="3,500" hint="After taxes — what actually hits your account" />
          <Row2>
            <Field label="Partner take-home (if any)" name="partner_income" prefix="$" placeholder="0" />
            <Field label="Other regular monthly income" name="other_income" prefix="$" placeholder="0" hint="Rental, freelance, etc." />
          </Row2>
          <Row2>
            <Field label="Gross annual household salary" name="gross_annual" prefix="$" placeholder="75,000" hint="Before tax, rough is fine" />
            <Field label="Annual bonus (if any)" name="bonus_amount" prefix="$" placeholder="0" />
          </Row2>
          <Field label="Bonus arrival month (if applicable)" name="bonus_month" placeholder="e.g. March" hint="Applied as a lump sum in that month" />
          <NextBtn sectionId="income" />
        </>
      ),
      expenses_regular: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Monthly recurring only. If you pay car insurance every 6 months, leave this blank and enter it in Annual Expenses.</p>
          <Divider label="Housing" />
          <Row2>
            <Field label="Rent or mortgage" name="rent_mortgage" prefix="$" placeholder="1,200" />
            <Field label="Property tax (direct only)" name="property_tax" prefix="$" placeholder="0" />
          </Row2>
          <Row2><Field label="HOA fees" name="hoa" prefix="$" placeholder="0" /></Row2>
          <Divider label="Utilities & Services" />
          <Row2>
            <Field label="Electric / gas" name="electric_gas" prefix="$" placeholder="120" />
            <Field label="Water / sewer" name="water" prefix="$" placeholder="50" />
          </Row2>
          <Row2>
            <Field label="Internet" name="internet" prefix="$" placeholder="65" />
            <Field label="Cell phone" name="phone" prefix="$" placeholder="80" />
          </Row2>
          <Field label="Streaming & subscriptions (total)" name="streaming" prefix="$" placeholder="45" />
          <Divider label="Transportation" />
          <Row2>
            <Field label="Car payment(s)" name="car_payment" prefix="$" placeholder="0" hint="Loan/lease only — not insurance" />
            <Field label="Car insurance (if monthly)" name="car_insurance_monthly" prefix="$" placeholder="0" hint="Skip if you pay annually" />
          </Row2>
          <Field label="Gas" name="gas" prefix="$" placeholder="120" />
          <Divider label="Food" />
          <Row2>
            <Field label="Groceries" name="groceries" prefix="$" placeholder="400" />
            <Field label="Dining out / takeout" name="dining" prefix="$" placeholder="200" />
          </Row2>
          <Divider label="Health & Insurance" />
          <Row2>
            <Field label="Health insurance (out of pocket)" name="health_insurance" prefix="$" placeholder="0" hint="Skip if pre-tax from paycheck" />
            <Field label="Medical copays / prescriptions" name="medical_copays" prefix="$" placeholder="30" />
          </Row2>
          <Divider label="Family & Personal" />
          <Row2>
            <Field label="Childcare / tuition" name="childcare" prefix="$" placeholder="0" />
            <Field label="Pets (food, meds, grooming)" name="pets" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field label="Personal care (haircuts etc)" name="personal_care" prefix="$" placeholder="0" />
            <Field label="Gym / fitness" name="gym" prefix="$" placeholder="0" />
          </Row2>
          <Divider label="Savings & Misc" />
          <Row2>
            <Field label="Auto savings transfers" name="savings_transfers" prefix="$" placeholder="0" hint="Out of pocket only" />
            <Field label="Monthly buffer / misc" name="misc_buffer" prefix="$" placeholder="100" />
          </Row2>
          <Field label="Anything else monthly" name="other_monthly" prefix="$" placeholder="0" hint="Storage, donations, union dues, etc." />
          <NextBtn sectionId="expenses_regular" />
        </>
      ),
      expenses_irregular: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Enter annual totals — they get divided by 12 for your plan. This is where most plans go wrong.</p>
          <Row2>
            <Field label="Car insurance (annual total)" name="car_insurance_annual" prefix="$" placeholder="0" />
            <Field label="Home / renters insurance" name="home_insurance_annual" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field label="Amazon Prime / memberships" name="amazon_prime" prefix="$" placeholder="0" />
            <Field label="Car registration / inspection" name="car_registration" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field label="Vet bills (annual estimate)" name="vet_annual" prefix="$" placeholder="0" />
            <Field label="Holiday / gift spending" name="holiday_spending" prefix="$" placeholder="0" />
          </Row2>
          <Row2>
            <Field label="Vacation / travel" name="vacation_annual" prefix="$" placeholder="0" />
            <Field label="Other annual costs" name="other_irregular" prefix="$" placeholder="0" />
          </Row2>
          <NextBtn sectionId="expenses_irregular" />
        </>
      ),
      debts: (
        <>
          <p style={{ color:"#475569", fontSize:12, marginBottom:14 }}>Add every debt. Use whatever name makes sense to you. Estimates are fine.</p>
          {form.debts.map((debt, idx) => (
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
                {[["Balance","balance","$","","5,000"],["Interest Rate %","rate","","% APR","19.99"],["Min Payment","min","$","","100"]].map(([label,key,pre,suf,ph]) => (
                  <div key={key}>
                    <label style={labelStyle}>{label}</label>
                    <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:7, border:"1px solid #334155", overflow:"hidden" }}>
                      {pre && <span style={{ padding:"0 8px", color:"#475569", fontSize:12 }}>{pre}</span>}
                      <input value={debt[key]} onChange={e=>updateDebt(idx,key,e.target.value)} placeholder={ph} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:13, padding:"9px 6px" }} />
                      {suf && <span style={{ padding:"0 8px", color:"#475569", fontSize:11 }}>{suf}</span>}
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
          {form.debts.length > 0 && (
            <div style={{ marginTop:14, padding:14, background:"#0a0f1a", borderRadius:10, border:"1px solid #1e293b", display:"flex", gap:20 }}>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Total Debt</span><span style={{ fontSize:18, fontWeight:700, color:"#f87171" }}>${totalDebt.toLocaleString()}</span></div>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Min Payments/mo</span><span style={{ fontSize:18, fontWeight:700, color:"#fbbf24" }}>${totalMins.toLocaleString()}</span></div>
              <div><span style={{ fontSize:10, color:"#334155", display:"block", textTransform:"uppercase", letterSpacing:"0.05em" }}>Debts</span><span style={{ fontSize:18, fontWeight:700, color:"#22a89a" }}>{form.debts.length}</span></div>
            </div>
          )}
          <NextBtn sectionId="debts" disabled={form.debts.length === 0} />
        </>
      ),
      goals: (
        <>
          <div style={{ marginBottom:18 }}>
            <label style={labelStyle}>Your #1 priority</label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {PRIORITIES.map(p => (
                <button key={p.value} onClick={()=>setField("priority",p.value)} style={{ padding:"12px 14px", borderRadius:9, border:`2px solid ${form.priority===p.value?"#22a89a":"#1e293b"}`, background:form.priority===p.value?"rgba(26,122,110,0.12)":"#0f172a", color:form.priority===p.value?"#22a89a":"#475569", textAlign:"left", cursor:"pointer" }}>
                  <div style={{ fontWeight:700, fontSize:12, marginBottom:2 }}>{p.label}</div>
                  <div style={{ fontSize:11 }}>{p.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div style={{ background:"#0a0f1a", borderRadius:10, border:"1px solid #1e293b", padding:16, marginBottom:16 }}>
            <label style={labelStyle}>Monthly commitment to debt payoff</label>
            {totalMins > 0 && <p style={{ color:"#475569", fontSize:12, marginBottom:10 }}>Your minimums total <strong style={{color:"#fbbf24"}}>${totalMins.toLocaleString()}/mo</strong>. Any amount above that accelerates your plan.</p>}
            <div style={{ display:"flex", alignItems:"center", background:"#1e293b", borderRadius:8, border:"1px solid #334155", overflow:"hidden" }}>
              <span style={{ padding:"0 10px", color:"#475569", fontSize:14, borderRight:"1px solid #334155", lineHeight:"40px" }}>$</span>
              <input value={form.monthly_committed} onChange={e=>setField("monthly_committed",e.target.value)} placeholder={totalMins?`${totalMins} min, more = faster`:"e.g. 800"} style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#f1f5f9", fontSize:14, padding:"0 12px", height:40 }} />
              <span style={{ padding:"0 10px", color:"#475569", fontSize:12 }}>/mo</span>
            </div>
          </div>
          <Row2>
            <Field label="Emergency fund (current)" name="emergency_fund_current" prefix="$" placeholder="0" />
            <Field label="Emergency fund (target)" name="emergency_fund_target" prefix="$" placeholder="10,000" />
          </Row2>
          <label style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:13, cursor:"pointer", marginBottom:14 }}>
            <input type="checkbox" checked={form.open_to_refi} onChange={e=>setField("open_to_refi",e.target.checked)} /> Open to refinancing if it saves meaningful money
          </label>
          <Field label="Any debt you especially want gone first?" name="emotional_priority" placeholder='e.g. "my Discover card"' hint="Optional — we'll factor in emotional priorities" />
          <Field label="Big upcoming expenses in the next 1–2 years?" name="upcoming_expenses" placeholder="Wedding, renovation, new baby…" hint="Optional" />
          <NextBtn sectionId="goals" disabled={!form.monthly_committed} />
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
            <p style={{ color:"#334155", fontSize:13 }}>Fill out each section, then generate your plan at the bottom.</p>
          </div>

          {SECTIONS.map(sec => {
            const isOpen = openSection === sec.id;
            const isDone = completedSections.has(sec.id);
            return (
              <div key={sec.id} style={{ marginBottom:10, borderRadius:12, border:`1px solid ${isOpen?"#22a89a":isDone?"#1e3a34":"#1e293b"}`, overflow:"hidden" }}>
                <button onClick={()=>setOpenSection(isOpen?null:sec.id)} style={{ width:"100%", background:isOpen?"#0d2420":isDone?"#0a1f1c":"#0f172a", border:"none", padding:"16px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:18 }}>{isDone?"✅":sec.icon}</span>
                    <span style={{ fontSize:14, fontWeight:600, color:isOpen?"#22a89a":isDone?"#4ade80":"#64748b" }}>{sec.label}</span>
                  </div>
                  <span style={{ color:"#334155", fontSize:11, transform:isOpen?"rotate(180deg)":"none", transition:"transform 0.2s" }}>▼</span>
                </button>
                {isOpen && (
                  <div style={{ background:"#0f172a", padding:"20px 20px 6px", borderTop:"1px solid #1e293b" }}>
                    {sectionContent[sec.id]}
                  </div>
                )}
              </div>
            );
          })}

          {/* Generate */}
          <div style={{ marginTop:28, background:"#0f172a", borderRadius:14, border:"1px solid #1e3a34", padding:24, textAlign:"center" }}>
            <h2 style={{ fontSize:18, fontWeight:700, color:"#f1f5f9", margin:"0 0 6px" }}>Ready to see your plan?</h2>
            {totalDebt > 0 && <p style={{ color:"#334155", fontSize:13, margin:"0 0 18px" }}>{form.debts.length} debt{form.debts.length!==1?"s":""} · <span style={{color:"#f87171"}}>${totalDebt.toLocaleString()}</span> · <span style={{color:"#22a89a"}}>${parseFloat(form.monthly_committed||0).toLocaleString()}/mo</span></p>}
            {planError && <p style={{ color:"#f87171", fontSize:13, marginBottom:14 }}>{planError}</p>}
            <button onClick={generatePlan} disabled={planLoading||!form.debts.length||!form.monthly_committed} style={{ background:planLoading||!form.debts.length||!form.monthly_committed?"#1e293b":"linear-gradient(135deg,#1A7A6E,#22a89a)", color:planLoading||!form.debts.length||!form.monthly_committed?"#334155":"white", border:"none", borderRadius:10, padding:"14px 36px", fontSize:15, fontWeight:700, cursor:"pointer", boxShadow:"0 4px 20px rgba(26,122,110,0.25)" }}>
              {planLoading ? "⏳ Calculating your plan…" : "🧭 Generate My Debt-Free Plan →"}
            </button>
            {(!form.debts.length||!form.monthly_committed) && <p style={{ color:"#334155", fontSize:11, marginTop:8 }}>{!form.debts.length?"Add at least one debt first":"Enter your monthly commitment in Goals"}</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── PLAN SCREEN ─────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#0a0f1a", fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={headerStyle}>
        {logoBlock}
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={()=>setScreen("form")} style={{ background:"transparent", border:"1px solid #1e293b", borderRadius:7, color:"#475569", fontSize:12, padding:"7px 14px", cursor:"pointer" }}>← Edit</button>
          <button onClick={async()=>{
            try {
              const res = await fetch("/api/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(buildPayload()) });
              if (!res.ok) throw new Error();
              const blob = await res.blob();
              const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
              a.download = `Clearpath_${form.name||"Plan"}.xlsx`; a.click();
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
              {qaLoading && <div style={{display:"flex"}}><div style={{background:"#1e293b",borderRadius:"12px 12px 12px 3px",padding:"9px 13px"}}><span style={{color:"#334155",fontSize:12}}>Thinking…</span></div></div>}
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

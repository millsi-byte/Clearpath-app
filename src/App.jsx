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
1. Give a warm 1-sentence acknowledgment
2. Show a clean summary: list each expense category with amount, total monthly expenses
3. Ask ONE clarifying question ONLY if something seems off (e.g. a category seems unusually high or low). If everything looks reasonable, just ask "Does this look right, or anything to adjust?"
4. Keep it conversational and warm. Never judgmental.`,

  expenses_irregular: (data) => `You are a warm, encouraging debt payoff assistant. The user just filled out their irregular/annual expenses.

IRREGULAR EXPENSES DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Give a warm 1-sentence acknowledgment
2. Show a clean summary: list each irregular expense with amount, frequency, and monthly equivalent
3. Calculate the total annual cost and monthly equivalent (total annual / 12)
4. Ask "Does this look right, or anything to adjust?"
5. Keep it conversational and warm.`,

  debts: (data) => `You are a warm, encouraging debt payoff assistant. The user just filled out their debts.

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
- Cascade: when debt hits $0, its minimum rolls into next target
- Extra monthly = monthly_committed - sum of all minimums
- Deferred loans: balance grows monthly, no payments until activation
- HELOC IO: minimum = (rate/12) × balance only

OUTPUT — respond with exactly this structure:

## Your Three Plans

### Plan A — Avalanche
**Attack order:** [list debts highest rate first]
**Debt-free date:** [Month Year]
**Total interest paid:** $[X]
**Saves vs minimums only:** $[X]
**First payoff:** [debt name] — [Month Year]
**Tradeoff:** [honest note]

### Plan B — Snowball  
**Attack order:** [list debts smallest balance first]
**Debt-free date:** [Month Year]
**Total interest paid:** $[X]
**Saves vs minimums only:** $[X]
**First payoff:** [debt name] — [Month Year]
**Tradeoff:** [honest note]

### Plan C — [Custom Name]
**Why this plan:** [1-2 sentences specific to their situation]
**Attack order:** [list]
**Debt-free date:** [Month Year]
**Total interest paid:** $[X]
**Saves vs minimums only:** $[X]
**Tradeoff:** [honest note]

---

**My recommendation:** Plan [X] — [1-2 sentence personal reason using their actual debt names].

---

## Roadmap: [Chosen Plan Name]

### Key Milestones
[List each payoff date and any cliff events like deferred loan activations]

### Year-by-Year Projection
| Year | [Debt 1] | [Debt 2] | ... | Total Remaining |
|------|----------|----------|-----|-----------------|
[One row per year]

### Month-by-Month (First 24 Months)
| Month | Extra Goes To | [Debt 1] Bal | [Debt 2] Bal | ... |
|-------|--------------|-------------|-------------|-----|
[24 rows]`;

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMd(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} style={{ color: "#22a89a", fontSize: 14, fontWeight: 700, margin: "16px 0 6px", letterSpacing: 0.3 }}>{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} style={{ color: "#e8c87a", fontSize: 16, fontWeight: 700, margin: "20px 0 8px" }}>{line.slice(3)}</h2>);
    } else if (line.startsWith("**") && line.endsWith("**")) {
      elements.push(<p key={i} style={{ color: "#c9e8e5", fontWeight: 600, fontSize: 13, margin: "4px 0" }}>{line.slice(2, -2)}</p>);
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      elements.push(<p key={i} style={{ color: "#c9e8e5", fontSize: 13, margin: "2px 0 2px 12px" }}>• {line.slice(2)}</p>);
    } else if (line.startsWith("|")) {
      // Table row
      const cells = line.split("|").filter((_, idx) => idx > 0 && idx < line.split("|").length - 1);
      const isHeader = lines[i + 1]?.startsWith("|---");
      if (!isHeader && line !== lines[i - 1] && !lines[i - 1]?.startsWith("|---")) {
        elements.push(
          <div key={i} style={{ display: "flex", gap: 1, marginBottom: 1 }}>
            {cells.map((c, j) => (
              <div key={j} style={{ flex: 1, padding: "4px 8px", background: "#0d2420", color: "#c9e8e5", fontSize: 12, minWidth: 0, wordBreak: "break-word" }}>
                {c.trim().replace(/\*\*/g, "")}
              </div>
            ))}
          </div>
        );
      } else if (isHeader) {
        elements.push(
          <div key={i} style={{ display: "flex", gap: 1, marginBottom: 1 }}>
            {cells.map((c, j) => (
              <div key={j} style={{ flex: 1, padding: "4px 8px", background: "#0f3330", color: "#22a89a", fontSize: 11, fontWeight: 700, minWidth: 0 }}>
                {c.trim()}
              </div>
            ))}
          </div>
        );
      }
    } else if (line.trim() === "---") {
      elements.push(<hr key={i} style={{ border: "none", borderTop: "1px solid #1e3a34", margin: "16px 0" }} />);
    } else if (line.trim()) {
      // Inline bold
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      elements.push(
        <p key={i} style={{ color: "#c9e8e5", fontSize: 13, lineHeight: 1.6, margin: "3px 0" }}>
          {parts.map((p, j) =>
            p.startsWith("**") && p.endsWith("**")
              ? <strong key={j} style={{ color: "#e8f5f3", fontWeight: 600 }}>{p.slice(2, -2)}</strong>
              : p
          )}
        </p>
      );
    } else {
      elements.push(<div key={i} style={{ height: 6 }} />);
    }
    i++;
  }
  return elements;
}

// ── Inline AI review chat thread ──────────────────────────────────────────────
function ReviewPanel({ sectionId, review, onSendMessage, onConfirm, onEdit }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [review.messages]);

  return (
    <div style={{ marginTop: 20, borderRadius: 12, border: "1px solid #1e3a34", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ background: "#0d2420", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14 }}>🤖</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#22a89a" }}>Clearpath Review</span>
        </div>
        {review.status === "confirmed" && (
          <button onClick={onEdit} style={{ background: "none", border: "1px solid #334155", borderRadius: 6, color: "#8cb8b4", fontSize: 11, padding: "4px 10px", cursor: "pointer" }}>
            Edit section
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ background: "#0a1f1c", padding: 14, display: "flex", flexDirection: "column", gap: 10, maxHeight: 300, overflowY: "auto" }}>
        {review.messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "88%", padding: "9px 13px",
              borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
              background: m.role === "user" ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e293b",
              color: "#f1f5f9", fontSize: 13, lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {review.loading && (
          <div style={{ display: "flex" }}>
            <div style={{ background: "#1e293b", borderRadius: "12px 12px 12px 3px", padding: "9px 13px" }}>
              <span style={{ color: "#8cb8b4", fontSize: 12 }}>Reviewing…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input or Confirm */}
      {review.status !== "confirmed" && (
        <div style={{ padding: 10, borderTop: "1px solid #1e3a34", background: "#0d2420" }}>
          {review.status === "ready_to_confirm" ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => onSendMessage("Looks good, let's continue!")} style={{ flex: 1, background: "#0f3330", border: "1px solid #1e3a34", borderRadius: 7, color: "#8cb8b4", fontSize: 12, padding: "8px 12px", cursor: "pointer", textAlign: "left" }}>
                ✏️ Make a change
              </button>
              <button onClick={onConfirm} style={{ flex: 1, background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 7, color: "white", fontSize: 12, fontWeight: 600, padding: "8px 12px", cursor: "pointer" }}>
                ✅ Looks right, continue →
              </button>
            </div>
          ) : (
            <ReviewInput onSend={onSendMessage} loading={review.loading} />
          )}
        </div>
      )}
    </div>
  );
}

function ReviewInput({ onSend, loading }) {
  const [val, setVal] = useState("");
  const send = () => { if (val.trim() && !loading) { onSend(val); setVal(""); } };
  return (
    <div style={{ display: "flex", gap: 7 }}>
      <input
        value={val} onChange={e => setVal(e.target.value)}
        onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
        placeholder="Reply to Clearpath…"
        style={{ flex: 1, background: "#0f1f1c", border: "1px solid #334155", borderRadius: 7, color: "#e8f0ee", fontSize: 12, padding: "8px 10px", outline: "none" }}
      />
      <button onClick={send} disabled={loading || !val.trim()} style={{ background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 7, padding: "8px 12px", cursor: loading || !val.trim() ? "not-allowed" : "pointer", color: "white", fontSize: 13 }}>→</button>
    </div>
  );
}

// ── Months helper ─────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("code"); // code | interview | plan
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [sessionCode, setSessionCode] = useState("");

  // Interview state
  const [step, setStep] = useState(0); // 0=name,1=income,2=expenses_regular,3=expenses_irregular,4=debts,5=goals
  const [form, setForm] = useState({
    name: "",
    // Income
    gross_annual: "",
    monthly_takehome: "",
    partner_income: "",
    other_income: "",
    extra_income: [], // [{name,amount}]
    bonus_type: "amount", // "amount"|"percent"
    bonus_amount: "",
    bonus_percent: "",
    bonus_month: "December",
    stock_grants: [], // [{name,grant_date,total_amount,vest_frequency,vest_duration,tax_withholding}]
    // Monthly expenses
    rent: "", mortgage: "", property_tax: "", hoa: "", renters_insurance: "",
    electric_gas: "", water: "", internet: "",
    streaming_video: "", streaming_music: "", other_subscriptions: "",
    cell_phone: "",
    car_payment: "", car_insurance_monthly: "", gas: "", parking_tolls: "",
    groceries: "", dining_out: "",
    health_insurance: "", life_insurance: "", dental_vision: "", medical_copays: "",
    childcare: "", child_support_paid: "", pets: "", personal_care: "", gym: "",
    savings_transfers: "",
    misc_buffer: "",
    other_monthly: "",
    // Irregular expenses
    irregular_expenses: [], // [{name, mode:"spread"|"specific", entries:[{month,amount}], annual_total}]
    extra_annual: [], // legacy catch-all
    // Debts
    debts: [],
    // Goals
    priority: "balanced",
    emergency_fund_current: "",
    emergency_fund_target: "",
    open_to_refi: false,
    emotional_priority: "",
    upcoming_expenses: "",
    monthly_committed: "",
  });

  // Reviews per section
  const [reviews, setReviews] = useState({
    intro: { status: "idle", messages: [], loading: false },
    income: { status: "idle", messages: [], loading: false },
    expenses_regular: { status: "idle", messages: [], loading: false },
    expenses_irregular: { status: "idle", messages: [], loading: false },
    debts: { status: "idle", messages: [], loading: false },
    goals: { status: "idle", messages: [], loading: false },
  });

  // Plan state
  const [planText, setPlanText] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const [qaMessages, setQaMessages] = useState([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaEndRef = useRef(null);
  useEffect(() => { qaEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [qaMessages]);

  // ── Access code check ────────────────────────────────────────────────────────
  async function checkCode() {
    setCodeLoading(true); setCodeError("");
    try {
      const res = await sbFetch(`access_codes?code=eq.${encodeURIComponent(codeInput.trim().toUpperCase())}&select=code`);
      const data = await res.json();
      if (!data?.length) { setCodeError("Code not found. Check your confirmation email."); setCodeLoading(false); return; }
      setSessionCode(codeInput.trim().toUpperCase());
      setScreen("interview");
    } catch {
      setCodeError("Connection error. Please try again.");
    }
    setCodeLoading(false);
  }

  // ── Claude API call ──────────────────────────────────────────────────────────
  async function callClaude(systemPrompt, messages) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages,
      }),
    });
    const data = await res.json();
    return data.content?.map(b => b.text || "").join("") || "";
  }

  // ── Start a review section ───────────────────────────────────────────────────
  async function startReview(sectionId, promptFn, data) {
    setReviews(r => ({ ...r, [sectionId]: { status: "active", messages: [], loading: true } }));
    const prompt = promptFn(data);
    const reply = await callClaude(prompt, [{ role: "user", content: "Please review my data." }]);
    setReviews(r => ({
      ...r,
      [sectionId]: {
        status: "ready_to_confirm",
        messages: [{ role: "assistant", content: reply }],
        loading: false,
      },
    }));
  }

  async function sendReviewMessage(sectionId, text, promptFn, data) {
    setReviews(r => ({
      ...r,
      [sectionId]: {
        ...r[sectionId],
        status: "active",
        messages: [...r[sectionId].messages, { role: "user", content: text }],
        loading: true,
      },
    }));
    const history = [...reviews[sectionId].messages, { role: "user", content: text }];
    const reply = await callClaude(promptFn(data), history);
    setReviews(r => ({
      ...r,
      [sectionId]: {
        status: "ready_to_confirm",
        messages: [...r[sectionId].messages, { role: "user", content: text }, { role: "assistant", content: reply }],
        loading: false,
      },
    }));
  }

  function confirmReview(sectionId) {
    setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], status: "confirmed" } }));
    setStep(s => s + 1);
  }

  function editSection(sectionId, stepNum) {
    setReviews(r => ({ ...r, [sectionId]: { status: "idle", messages: [], loading: false } }));
    setStep(stepNum);
  }

  // ── Derived calculations ─────────────────────────────────────────────────────
  function buildPayload() {
    const f = form;
    const bonusAfterTax = f.bonus_type === "percent"
      ? Math.round((parseFloat(f.gross_annual) || 0) * (parseFloat(f.bonus_percent) || 0) / 100 * 0.72)
      : Math.round((parseFloat(f.bonus_amount) || 0) * 0.72);

    const stockWindfalls = f.stock_grants.map(g => {
      const total = parseFloat(g.total_amount) || 0;
      const vestFreq = parseInt(g.vest_frequency) || 12;
      const vestDur = parseInt(g.vest_duration) || 48;
      const vestCount = Math.floor(vestDur / vestFreq);
      const perVest = Math.round(total / vestCount * (1 - (parseFloat(g.tax_withholding) || 22) / 100));
      return { name: g.name, per_vest: perVest, frequency_months: vestFreq, grant_date: g.grant_date };
    });

    const regularExp = [
      ["Rent", f.rent], ["Mortgage", f.mortgage], ["Property Tax", f.property_tax],
      ["HOA", f.hoa], ["Renters Insurance", f.renters_insurance],
      ["Electric/Gas", f.electric_gas], ["Water", f.water], ["Internet", f.internet],
      ["Streaming Video", f.streaming_video], ["Streaming Music", f.streaming_music],
      ["Other Subscriptions", f.other_subscriptions], ["Cell Phone", f.cell_phone],
      ["Car Payment", f.car_payment], ["Car Insurance", f.car_insurance_monthly],
      ["Gas", f.gas], ["Parking/Tolls", f.parking_tolls],
      ["Groceries", f.groceries], ["Dining Out", f.dining_out],
      ["Health Insurance", f.health_insurance], ["Life Insurance", f.life_insurance],
      ["Dental/Vision", f.dental_vision], ["Medical Copays", f.medical_copays],
      ["Childcare", f.childcare], ["Child Support", f.child_support_paid],
      ["Pets", f.pets], ["Personal Care", f.personal_care], ["Gym", f.gym],
      ["Savings Transfers", f.savings_transfers], ["Misc Buffer", f.misc_buffer],
      ["Other Monthly", f.other_monthly],
    ].map(([name, v]) => ({ name, amount: parseFloat(v) || 0 }))
      .concat(f.extra_income.filter(e => e.name).map(e => ({ name: e.name, amount: parseFloat(e.amount) || 0 })))
      .filter(e => e.amount > 0);

    // Build irregular expenses from new structure
    const irregularExp = f.irregular_expenses
      .filter(e => e.name)
      .map(e => {
        const annual = e.mode === "spread"
          ? parseFloat(e.annual_total) || 0
          : e.entries.reduce((s, en) => s + (parseFloat(en.amount) || 0), 0);
        return {
          name: e.name,
          amount: annual,
          mode: e.mode,
          months: e.mode === "spread"
            ? [1,2,3,4,5,6,7,8,9,10,11,12]
            : e.entries.map(en => parseInt(en.month)),
          monthly_amounts: e.mode === "specific" ? e.entries.map(en => parseFloat(en.amount) || 0) : null,
        };
      })
      .concat(f.extra_annual.filter(e => e.name && parseFloat(e.amount) > 0).map(e => ({
        name: e.name, amount: parseFloat(e.amount) || 0, mode: "spread", months: [1,2,3,4,5,6,7,8,9,10,11,12],
      })));

    const monthlyIrreg = irregularExp.reduce((a, e) => a + e.amount, 0) / 12;
    const monthlyIn = (parseFloat(f.monthly_takehome) || 0)
      + (parseFloat(f.partner_income) || 0)
      + (parseFloat(f.other_income) || 0)
      + f.extra_income.filter(e => e.name).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalExp = regularExp.reduce((a, e) => a + e.amount, 0) + monthlyIrreg;
    const totalMins = f.debts.reduce((a, d) => a + (parseFloat(d.min) || 0), 0);
    const committed = parseFloat(f.monthly_committed) || 0;

    return {
      name: f.name || "there",
      today: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      income: {
        monthly_takehome: monthlyIn,
        gross_annual: parseFloat(f.gross_annual) || 0,
        partner: parseFloat(f.partner_income) || 0,
        other: parseFloat(f.other_income) || 0,
        extra: f.extra_income.filter(e => e.name).map(e => ({ name: e.name, amount: parseFloat(e.amount) || 0 })),
        bonus: bonusAfterTax > 0 ? { amount: bonusAfterTax, month: f.bonus_month } : null,
        stock_grants: stockWindfalls,
      },
      expenses: {
        regular: regularExp,
        irregular: irregularExp,
        monthly_irregular_equiv: Math.round(monthlyIrreg),
        total_monthly: Math.round(totalExp),
      },
      surplus: Math.round(monthlyIn - totalExp),
      debts: f.debts.map(d => ({
        name: d.name, balance: parseFloat(d.balance) || 0,
        rate: (parseFloat(d.rate) || 0) / 100,
        min: parseFloat(d.min) || 0, type: d.type,
        is_heloc_io: d.is_heloc_io,
        heloc_draw_ends: d.is_heloc_io && d.heloc_draw_ends_month ? { month: parseInt(d.heloc_draw_ends_month), year: parseInt(d.heloc_draw_ends_year) } : null,
        deferred_until: d.deferred && d.deferred_until_month ? { month: parseInt(d.deferred_until_month), year: parseInt(d.deferred_until_year) } : null,
      })),
      total_debt: f.debts.reduce((a, d) => a + (parseFloat(d.balance) || 0), 0),
      total_minimums: Math.round(totalMins),
      monthly_committed: committed,
      extra_monthly: Math.max(0, committed - totalMins),
      goals: {
        priority: f.priority,
        emergency_fund_current: parseFloat(f.emergency_fund_current) || 0,
        emergency_fund_target: parseFloat(f.emergency_fund_target) || 0,
        open_to_refi: f.open_to_refi,
        emotional_priority: f.emotional_priority,
        upcoming_expenses: f.upcoming_expenses,
      },
    };
  }

  async function generatePlan() {
    if (!form.debts.length) { setPlanError("Add at least one debt first."); return; }
    if (!form.monthly_committed) { setPlanError("Enter your monthly commitment in Goals."); return; }
    setPlanLoading(true); setPlanError("");
    const payload = buildPayload();
    const reply = await callClaude(PLAN_SYSTEM_PROMPT, [{ role: "user", content: JSON.stringify(payload, null, 2) }]);
    setPlanText(reply);
    setPlanLoading(false);
    setScreen("plan");
  }

  async function sendQA() {
    if (!qaInput.trim() || qaLoading) return;
    const msg = qaInput; setQaInput(""); setQaLoading(true);
    const history = [...qaMessages, { role: "user", content: msg }];
    setQaMessages(history);
    const payload = buildPayload();
    const reply = await callClaude(
      PLAN_SYSTEM_PROMPT + "\n\nOriginal plan:\n" + planText + "\n\nUser data:\n" + JSON.stringify(payload),
      history
    );
    setQaMessages(h => [...h, { role: "assistant", content: reply }]);
    setQaLoading(false);
  }

  // ── Debt helpers ─────────────────────────────────────────────────────────────
  function addDebt() {
    setForm(f => ({
      ...f, debts: [...f.debts, {
        name: "", balance: "", rate: "", min: "", type: "credit_card",
        is_heloc_io: false, heloc_draw_ends_month: "", heloc_draw_ends_year: "",
        deferred: false, deferred_until_month: "", deferred_until_year: "",
      }]
    }));
  }
  function updateDebt(i, k, v) {
    setForm(f => { const d = [...f.debts]; d[i] = { ...d[i], [k]: v }; return { ...f, debts: d }; });
  }
  function removeDebt(i) {
    setForm(f => ({ ...f, debts: f.debts.filter((_, idx) => idx !== i) }));
  }

  // ── Extra income helpers ─────────────────────────────────────────────────────
  function addExtraIncome() {
    setForm(f => ({ ...f, extra_income: [...f.extra_income, { name: "", amount: "" }] }));
  }
  function updateExtraIncome(i, k, v) {
    setForm(f => { const ei = [...f.extra_income]; ei[i] = { ...ei[i], [k]: v }; return { ...f, extra_income: ei }; });
  }
  function removeExtraIncome(i) {
    setForm(f => ({ ...f, extra_income: f.extra_income.filter((_, idx) => idx !== i) }));
  }

  // ── Stock grant helpers ──────────────────────────────────────────────────────
  function addStockGrant() {
    setForm(f => ({
      ...f,
      stock_grants: [...f.stock_grants, { name: "RSU", grant_date: "", total_amount: "", vest_frequency: "12", vest_duration: "48", tax_withholding: "22" }]
    }));
  }
  function updateStockGrant(i, k, v) {
    setForm(f => { const sg = [...f.stock_grants]; sg[i] = { ...sg[i], [k]: v }; return { ...f, stock_grants: sg }; });
  }
  function removeStockGrant(i) {
    setForm(f => ({ ...f, stock_grants: f.stock_grants.filter((_, idx) => idx !== i) }));
  }

  // ── Irregular expense helpers ────────────────────────────────────────────────
  function addIrregularExpense() {
    setForm(f => ({
      ...f,
      irregular_expenses: [...f.irregular_expenses, { name: "", mode: "spread", annual_total: "", entries: [{ month: "1", amount: "" }] }]
    }));
  }
  function updateIrregularExpense(i, k, v) {
    setForm(f => { const ie = [...f.irregular_expenses]; ie[i] = { ...ie[i], [k]: v }; return { ...f, irregular_expenses: ie }; });
  }
  function removeIrregularExpense(i) {
    setForm(f => ({ ...f, irregular_expenses: f.irregular_expenses.filter((_, idx) => idx !== i) }));
  }
  function addIrregularEntry(i) {
    setForm(f => {
      const ie = [...f.irregular_expenses];
      ie[i] = { ...ie[i], entries: [...ie[i].entries, { month: "1", amount: "" }] };
      return { ...f, irregular_expenses: ie };
    });
  }
  function updateIrregularEntry(i, j, k, v) {
    setForm(f => {
      const ie = [...f.irregular_expenses];
      const entries = [...ie[i].entries];
      entries[j] = { ...entries[j], [k]: v };
      ie[i] = { ...ie[i], entries };
      return { ...f, irregular_expenses: ie };
    });
  }
  function removeIrregularEntry(i, j) {
    setForm(f => {
      const ie = [...f.irregular_expenses];
      ie[i] = { ...ie[i], entries: ie[i].entries.filter((_, idx) => idx !== j) };
      return { ...f, irregular_expenses: ie };
    });
  }

  // ── Styling helpers ──────────────────────────────────────────────────────────
  const F = (label, key, type = "text", placeholder = "") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 12, color: "#c9e8e5", fontWeight: 600 }}>{label}</label>
      <input
        type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{ background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#e8f5f3", fontSize: 13, padding: "9px 12px", outline: "none", width: "100%", boxSizing: "border-box" }}
      />
    </div>
  );

  const inputStyle = { background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#e8f5f3", fontSize: 13, padding: "9px 12px", outline: "none", width: "100%", boxSizing: "border-box" };
  const labelStyle = { fontSize: 12, color: "#c9e8e5", fontWeight: 600 };
  const sectionHead = (title, subtitle) => (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ color: "#e8c87a", fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ color: "#8cb8b4", fontSize: 13, margin: "4px 0 0" }}>{subtitle}</p>}
    </div>
  );
  const groupHead = (title) => (
    <div style={{ borderBottom: "1px solid #1e3a34", paddingBottom: 6, marginBottom: 14, marginTop: 24 }}>
      <span style={{ color: "#22a89a", fontSize: 13, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>{title}</span>
    </div>
  );
  const btnPrimary = { background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 8, color: "white", fontSize: 13, fontWeight: 600, padding: "11px 20px", cursor: "pointer" };
  const btnSecondary = { background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#8cb8b4", fontSize: 13, padding: "9px 16px", cursor: "pointer" };

  // ── Steps ────────────────────────────────────────────────────────────────────
  const STEPS = ["Welcome", "Income", "Monthly Expenses", "Annual Expenses", "Debts", "Goals"];

  // ── Screens ──────────────────────────────────────────────────────────────────

  // CODE SCREEN
  if (screen === "code") {
    return (
      <div style={{ minHeight: "100vh", background: "#07120f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 420, width: "100%" }}>
          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#1A7A6E,#22a89a)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 18 }}>🧭</span>
              </div>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#e8f5f3", letterSpacing: -0.5 }}>Clearpath</span>
            </div>
            <p style={{ color: "#22a89a", fontSize: 13, margin: 0, letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}>Debt Payoff Planner</p>
          </div>

          <div style={{ background: "#0d2420", borderRadius: 16, border: "1px solid #1e3a34", padding: 32 }}>
            <h2 style={{ color: "#e8f5f3", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Welcome back</h2>
            <p style={{ color: "#8cb8b4", fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>Enter the access code from your confirmation email to get started.</p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                value={codeInput} onChange={e => setCodeInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && checkCode()}
                placeholder="CLEAR-XXXX-XXXX"
                style={{ ...inputStyle, fontSize: 15, padding: "12px 16px", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}
              />
              {codeError && <p style={{ color: "#f87171", fontSize: 12, margin: 0 }}>{codeError}</p>}
              <button onClick={checkCode} disabled={codeLoading || !codeInput.trim()} style={{ ...btnPrimary, padding: "13px", fontSize: 14, opacity: codeLoading || !codeInput.trim() ? 0.5 : 1 }}>
                {codeLoading ? "Checking…" : "Enter →"}
              </button>
            </div>

            <p style={{ color: "#475569", fontSize: 12, marginTop: 20, textAlign: "center" }}>
              Purchased on Etsy? Check your order confirmation for your code.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // PLAN SCREEN
  if (screen === "plan") {
    const payload = buildPayload();
    return (
      <div style={{ minHeight: "100vh", background: "#07120f", fontFamily: "'Inter', sans-serif" }}>
        {/* Header */}
        <div style={{ background: "#0d2420", borderBottom: "1px solid #1e3a34", padding: "14px 24px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
          <span style={{ fontSize: 18 }}>🧭</span>
          <span style={{ fontSize: 16, fontWeight: 800, color: "#e8f5f3" }}>Clearpath</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#8cb8b4" }}>
            <span style={{ color: "#f87171", fontWeight: 600 }}>{payload.debts.length} debts</span>
            {" · "}
            <span style={{ color: "#e8c87a", fontWeight: 600 }}>${payload.total_debt.toLocaleString()}</span>
            {" · "}
            <span style={{ color: "#22a89a", fontWeight: 600 }}>${(parseFloat(form.monthly_committed) || 0).toLocaleString()}/mo</span>
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, maxWidth: 1100, margin: "0 auto", padding: 24 }}>
          {/* Plan */}
          <div style={{ paddingRight: 24 }}>
            {planLoading ? (
              <div style={{ color: "#8cb8b4", padding: 40, textAlign: "center" }}>Calculating your plan…</div>
            ) : (
              <div>{renderMd(planText)}</div>
            )}
          </div>

          {/* Q&A Sidebar */}
          <div style={{ position: "sticky", top: 68 }}>
            <div style={{ background: "#0f172a", borderRadius: 14, border: "1px solid #1e293b", overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #1e293b", background: "#0d2420" }}>
                <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#22a89a" }}>💬 Ask Me Anything</h3>
                <p style={{ margin: "3px 0 0", fontSize: 11, color: "#8cb8b4" }}>What-ifs · explanations · next steps</p>
              </div>
              <div style={{ height: 340, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {qaMessages.map((m, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                    <div style={{ maxWidth: "90%", padding: "9px 13px", borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", background: m.role === "user" ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e293b", color: "#f1f5f9", fontSize: 12, lineHeight: 1.6 }}>{m.content}</div>
                  </div>
                ))}
                {qaLoading && <div style={{ display: "flex" }}><div style={{ background: "#1e293b", borderRadius: "12px 12px 12px 3px", padding: "9px 13px" }}><span style={{ color: "#8cb8b4", fontSize: 12 }}>Thinking…</span></div></div>}
                <div ref={qaEndRef} />
              </div>
              <div style={{ padding: 10, borderTop: "1px solid #1e293b" }}>
                <div style={{ display: "flex", gap: 7 }}>
                  <input value={qaInput} onChange={e => setQaInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendQA()} placeholder="Ask a question…" style={{ flex: 1, background: "#1e293b", border: "1px solid #334155", borderRadius: 7, color: "#f1f5f9", fontSize: 12, padding: "9px 11px", outline: "none" }} />
                  <button onClick={sendQA} disabled={qaLoading || !qaInput.trim()} style={{ background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 7, padding: "9px 13px", cursor: "pointer", color: "white", fontSize: 13 }}>→</button>
                </div>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                  {["What should I do first this month?", "What if I get a $3,000 bonus?", "Explain the avalanche method"].map(q => (
                    <button key={q} onClick={() => setQaInput(q)} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 7, color: "#8cb8b4", fontSize: 11, padding: "7px 11px", cursor: "pointer", textAlign: "left" }} onMouseEnter={e => { e.target.style.color = "#22a89a"; e.target.style.borderColor = "#22a89a"; }} onMouseLeave={e => { e.target.style.color = "#8cb8b4"; e.target.style.borderColor = "#1e293b"; }}>{q}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // INTERVIEW SCREEN
  const reviewConfirmed = (id) => reviews[id].status === "confirmed";

  return (
    <div style={{ minHeight: "100vh", background: "#07120f", fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div style={{ background: "#0d2420", borderBottom: "1px solid #1e3a34", padding: "12px 24px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ fontSize: 18 }}>🧭</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: "#e8f5f3" }}>Clearpath</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{
                width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                background: i < step ? "#22a89a" : i === step ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e3a34",
                fontSize: 10, fontWeight: 700, color: i <= step ? "white" : "#475569",
              }}>{i < step ? "✓" : i + 1}</div>
              {i < STEPS.length - 1 && <div style={{ width: 16, height: 1, background: i < step ? "#22a89a" : "#1e3a34" }} />}
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px" }}>

        {/* STEP 0: Welcome */}
        {step === 0 && (
          <div>
            {sectionHead("Welcome to Clearpath 🧭", "Let's build your personalized debt payoff plan. This takes about 20–30 minutes.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24, marginBottom: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={labelStyle}>What's your first name?</label>
                <input
                  value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === "Enter" && form.name.trim() && setStep(1)}
                  placeholder="e.g. Sarah"
                  style={inputStyle}
                  autoFocus
                />
              </div>
            </div>
            <button
              onClick={() => form.name.trim() && setStep(1)}
              disabled={!form.name.trim()}
              style={{ ...btnPrimary, opacity: !form.name.trim() ? 0.4 : 1 }}
            >
              Let's go →
            </button>
          </div>
        )}

        {/* STEP 1: Income */}
        {step === 1 && (
          <div>
            {sectionHead("Income", `Great to meet you, ${form.name}! Let's start with your household income.`)}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {groupHead("Household Salary")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Gross Annual Household Salary (before taxes)</label>
                  <input type="number" value={form.gross_annual} onChange={e => setForm(f => ({ ...f, gross_annual: e.target.value }))} placeholder="e.g. 120000" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Your Monthly Take-Home (after taxes)</label>
                  <input type="number" value={form.monthly_takehome} onChange={e => setForm(f => ({ ...f, monthly_takehome: e.target.value }))} placeholder="e.g. 4500" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Partner/Spouse Monthly Take-Home (if any)</label>
                  <input type="number" value={form.partner_income} onChange={e => setForm(f => ({ ...f, partner_income: e.target.value }))} placeholder="e.g. 3200" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Other Monthly Income (rental, freelance, etc.)</label>
                  <input type="number" value={form.other_income} onChange={e => setForm(f => ({ ...f, other_income: e.target.value }))} placeholder="e.g. 500" style={inputStyle} />
                </div>
              </div>

              {groupHead("Bonus")}
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                {["amount", "percent"].map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, bonus_type: t }))} style={{ ...btnSecondary, flex: 1, background: form.bonus_type === t ? "#1e3a34" : "#0d2420", border: form.bonus_type === t ? "1px solid #22a89a" : "1px solid #1e3a34", color: form.bonus_type === t ? "#22a89a" : "#8cb8b4" }}>
                    {t === "amount" ? "$ Fixed amount" : "% of gross salary"}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {form.bonus_type === "amount" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={labelStyle}>Bonus Amount (pre-tax)</label>
                    <input type="number" value={form.bonus_amount} onChange={e => setForm(f => ({ ...f, bonus_amount: e.target.value }))} placeholder="e.g. 8000" style={inputStyle} />
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={labelStyle}>Bonus % of Gross Salary</label>
                    <input type="number" value={form.bonus_percent} onChange={e => setForm(f => ({ ...f, bonus_percent: e.target.value }))} placeholder="e.g. 10" style={inputStyle} />
                    {form.bonus_percent && form.gross_annual && (
                      <span style={{ fontSize: 11, color: "#22a89a" }}>
                        ≈ ${Math.round((parseFloat(form.gross_annual) * parseFloat(form.bonus_percent) / 100) * 0.72).toLocaleString()} after ~28% tax
                      </span>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Typical Bonus Month</label>
                  <select value={form.bonus_month} onChange={e => setForm(f => ({ ...f, bonus_month: e.target.value }))} style={{ ...inputStyle }}>
                    {["January","February","March","April","May","June","July","August","September","October","November","December"].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              {groupHead("Stock Compensation")}
              {form.stock_grants.map((g, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      {["RSU", "ESPP", "Options", "Dividend"].map(t => (
                        <button key={t} onClick={() => updateStockGrant(i, "name", t)} style={{ ...btnSecondary, padding: "4px 10px", fontSize: 11, background: g.name === t ? "#1e3a34" : "#0d2420", border: g.name === t ? "1px solid #22a89a" : "1px solid #1e3a34", color: g.name === t ? "#22a89a" : "#8cb8b4" }}>{t}</button>
                      ))}
                    </div>
                    <button onClick={() => removeStockGrant(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Grant Date</label>
                      <input type="month" value={g.grant_date} onChange={e => updateStockGrant(i, "grant_date", e.target.value)} style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Total Grant Value ($)</label>
                      <input type="number" value={g.total_amount} onChange={e => updateStockGrant(i, "total_amount", e.target.value)} placeholder="e.g. 40000" style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Vest Every (months)</label>
                      <select value={g.vest_frequency} onChange={e => updateStockGrant(i, "vest_frequency", e.target.value)} style={inputStyle}>
                        <option value="3">Quarterly (3 mo)</option>
                        <option value="6">Semi-annual (6 mo)</option>
                        <option value="12">Annual (12 mo)</option>
                        <option value="1">Monthly (1 mo)</option>
                      </select>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Vesting Duration (months)</label>
                      <select value={g.vest_duration} onChange={e => updateStockGrant(i, "vest_duration", e.target.value)} style={inputStyle}>
                        <option value="12">1 year</option>
                        <option value="24">2 years</option>
                        <option value="36">3 years</option>
                        <option value="48">4 years</option>
                        <option value="60">5 years</option>
                      </select>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Tax Withholding %</label>
                      <input type="number" value={g.tax_withholding} onChange={e => updateStockGrant(i, "tax_withholding", e.target.value)} placeholder="22" style={inputStyle} />
                    </div>
                    {g.total_amount && g.vest_frequency && g.vest_duration && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, justifyContent: "flex-end" }}>
                        <span style={{ fontSize: 11, color: "#22a89a", lineHeight: 1.5 }}>
                          ≈ ${Math.round((parseFloat(g.total_amount) / Math.floor(parseInt(g.vest_duration) / parseInt(g.vest_frequency))) * (1 - (parseFloat(g.tax_withholding) || 22) / 100)).toLocaleString()} per vest event
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={addStockGrant} style={{ ...btnSecondary, fontSize: 12 }}>+ Add stock grant</button>

              {groupHead("Other Regular Income")}
              {form.extra_income.map((ei, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 140px 32px", gap: 10, marginBottom: 10 }}>
                  <input value={ei.name} onChange={e => updateExtraIncome(i, "name", e.target.value)} placeholder="Source (e.g. Rental income)" style={inputStyle} />
                  <input type="number" value={ei.amount} onChange={e => updateExtraIncome(i, "amount", e.target.value)} placeholder="$/month" style={inputStyle} />
                  <button onClick={() => removeExtraIncome(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20 }}>×</button>
                </div>
              ))}
              <button onClick={addExtraIncome} style={{ ...btnSecondary, fontSize: 12 }}>+ Add income source</button>
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => {
                const data = {
                  name: form.name,
                  gross_annual: form.gross_annual,
                  monthly_takehome: form.monthly_takehome,
                  partner_income: form.partner_income,
                  other_income: form.other_income,
                  extra_income: form.extra_income,
                  bonus_type: form.bonus_type,
                  bonus_amount: form.bonus_amount,
                  bonus_percent: form.bonus_percent,
                  bonus_month: form.bonus_month,
                  stock_grants: form.stock_grants,
                };
                startReview("income", REVIEW_PROMPTS.income, data);
              }} style={btnPrimary}>Review with Clearpath →</button>
            </div>

            {reviews.income.status !== "idle" && (
              <ReviewPanel
                sectionId="income"
                review={reviews.income}
                onSendMessage={(msg) => sendReviewMessage("income", msg, REVIEW_PROMPTS.income, { ...form })}
                onConfirm={() => confirmReview("income")}
                onEdit={() => editSection("income", 1)}
              />
            )}
          </div>
        )}

        {/* STEP 2: Monthly Expenses */}
        {step === 2 && (
          <div>
            {sectionHead("Monthly Expenses", "Monthly recurring costs only — things that hit every single month.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {[
                { head: "Housing", fields: [["Rent", "rent"], ["Mortgage", "mortgage"], ["Property Tax (if paid directly)", "property_tax"], ["HOA Fees", "hoa"], ["Renters Insurance", "renters_insurance"]] },
                { head: "Utilities", fields: [["Electric / Gas", "electric_gas"], ["Water / Sewer", "water"], ["Internet", "internet"]] },
                { head: "Streaming & Subscriptions", fields: [["Streaming Video (all services)", "streaming_video"], ["Streaming Music", "streaming_music"], ["Other Monthly Subscriptions", "other_subscriptions"]] },
                { head: "Phone", fields: [["Cell Phone Bill", "cell_phone"]] },
                { head: "Transportation", fields: [["Car Payment", "car_payment"], ["Car Insurance (only if paid monthly)", "car_insurance_monthly"], ["Gas", "gas"], ["Parking / Tolls / Transit", "parking_tolls"]] },
                { head: "Food", fields: [["Groceries", "groceries"], ["Dining Out & Takeout", "dining_out"]] },
                { head: "Insurance & Health", fields: [["Health Insurance (only if out-of-pocket)", "health_insurance"], ["Life Insurance (monthly)", "life_insurance"], ["Dental / Vision", "dental_vision"], ["Medical Copays (average)", "medical_copays"]] },
                { head: "Family & Personal", fields: [["Childcare / Daycare / Tuition", "childcare"], ["Child Support / Alimony Paid", "child_support_paid"], ["Pets (food, meds, grooming)", "pets"], ["Personal Care (hair, grooming)", "personal_care"], ["Gym / Fitness", "gym"]] },
                { head: "Savings & Other", fields: [["Savings / Investment Transfers", "savings_transfers"], ["Misc Buffer (unexpected costs)", "misc_buffer"], ["Other Monthly", "other_monthly"]] },
              ].map(({ head, fields }) => (
                <div key={head}>
                  {groupHead(head)}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {fields.map(([label, key]) => (
                      <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={labelStyle}>{label}</label>
                        <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={inputStyle} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => {
                const expData = {};
                ["rent","mortgage","property_tax","hoa","renters_insurance","electric_gas","water","internet","streaming_video","streaming_music","other_subscriptions","cell_phone","car_payment","car_insurance_monthly","gas","parking_tolls","groceries","dining_out","health_insurance","life_insurance","dental_vision","medical_copays","childcare","child_support_paid","pets","personal_care","gym","savings_transfers","misc_buffer","other_monthly"].forEach(k => { expData[k] = form[k]; });
                startReview("expenses_regular", REVIEW_PROMPTS.expenses_regular, expData);
              }} style={btnPrimary}>Review with Clearpath →</button>
            </div>

            {reviews.expenses_regular.status !== "idle" && (
              <ReviewPanel
                sectionId="expenses_regular"
                review={reviews.expenses_regular}
                onSendMessage={(msg) => sendReviewMessage("expenses_regular", msg, REVIEW_PROMPTS.expenses_regular, { ...form })}
                onConfirm={() => confirmReview("expenses_regular")}
                onEdit={() => editSection("expenses_regular", 2)}
              />
            )}
          </div>
        )}

        {/* STEP 3: Irregular / Annual Expenses */}
        {step === 3 && (
          <div>
            {sectionHead("Annual & Irregular Expenses", "Things that don't hit every month — insurance, subscriptions, holidays, etc. Include the month(s) they hit so your plan is accurate.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {/* Quick-add suggestions */}
              {groupHead("Common Annual Expenses")}
              <p style={{ fontSize: 12, color: "#8cb8b4", marginBottom: 14 }}>Click to add common ones, then fill in the details below.</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
                {["Car Insurance", "Home/Renters Insurance", "Amazon Prime", "Costco/Sam's Club", "Holiday Spending", "Vacation", "Car Registration", "Vet Bills", "Property Taxes", "Medical Deductible", "Dental Work"].map(name => {
                  const already = form.irregular_expenses.some(e => e.name === name);
                  return (
                    <button key={name} onClick={() => !already && setForm(f => ({
                      ...f,
                      irregular_expenses: [...f.irregular_expenses, { name, mode: "spread", annual_total: "", entries: [{ month: "1", amount: "" }] }]
                    }))} style={{ ...btnSecondary, fontSize: 11, padding: "5px 12px", opacity: already ? 0.4 : 1, cursor: already ? "default" : "pointer", border: already ? "1px solid #22a89a" : "1px solid #1e3a34", color: already ? "#22a89a" : "#8cb8b4" }}>
                      {already ? "✓ " : "+ "}{name}
                    </button>
                  );
                })}
              </div>

              {/* Expense items */}
              {form.irregular_expenses.map((exp, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12 }}>
                    <input
                      value={exp.name} onChange={e => updateIrregularExpense(i, "name", e.target.value)}
                      placeholder="Expense name"
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button onClick={() => removeIrregularExpense(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20, marginTop: 2, flexShrink: 0 }}>×</button>
                  </div>

                  {/* Mode toggle */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <button onClick={() => updateIrregularExpense(i, "mode", "spread")} style={{ ...btnSecondary, flex: 1, fontSize: 12, background: exp.mode === "spread" ? "#1e3a34" : "#0d2420", border: exp.mode === "spread" ? "1px solid #22a89a" : "1px solid #1e3a34", color: exp.mode === "spread" ? "#22a89a" : "#8cb8b4" }}>
                      📅 Spread evenly (÷12/mo)
                    </button>
                    <button onClick={() => updateIrregularExpense(i, "mode", "specific")} style={{ ...btnSecondary, flex: 1, fontSize: 12, background: exp.mode === "specific" ? "#1e3a34" : "#0d2420", border: exp.mode === "specific" ? "1px solid #22a89a" : "1px solid #1e3a34", color: exp.mode === "specific" ? "#22a89a" : "#8cb8b4" }}>
                      📆 Specific month(s)
                    </button>
                  </div>

                  {exp.mode === "spread" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Total Annual Amount</label>
                      <input type="number" value={exp.annual_total} onChange={e => updateIrregularExpense(i, "annual_total", e.target.value)} placeholder="e.g. 1200" style={{ ...inputStyle, maxWidth: 200 }} />
                      {exp.annual_total && <span style={{ fontSize: 11, color: "#22a89a" }}>≈ ${Math.round(parseFloat(exp.annual_total) / 12)}/mo set aside</span>}
                    </div>
                  ) : (
                    <div>
                      <label style={{ ...labelStyle, display: "block", marginBottom: 8 }}>Month(s) and amount(s) when this hits:</label>
                      {exp.entries.map((en, j) => (
                        <div key={j} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                          <select value={en.month} onChange={e => updateIrregularEntry(i, j, "month", e.target.value)} style={{ ...inputStyle, width: 130 }}>
                            {MONTH_NAMES.map((m, idx) => <option key={m} value={idx + 1}>{m}</option>)}
                          </select>
                          <input type="number" value={en.amount} onChange={e => updateIrregularEntry(i, j, "amount", e.target.value)} placeholder="Amount $" style={{ ...inputStyle, flex: 1 }} />
                          {exp.entries.length > 1 && (
                            <button onClick={() => removeIrregularEntry(i, j)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                          )}
                        </div>
                      ))}
                      <button onClick={() => addIrregularEntry(i)} style={{ ...btnSecondary, fontSize: 11, padding: "4px 10px" }}>+ Add another month</button>
                      <div style={{ marginTop: 6, fontSize: 11, color: "#22a89a" }}>
                        Total: ${exp.entries.reduce((s, en) => s + (parseFloat(en.amount) || 0), 0).toLocaleString()}/yr
                      </div>
                    </div>
                  )}
                </div>
              ))}

              <button onClick={addIrregularExpense} style={{ ...btnPrimary, fontSize: 12, marginTop: 4 }}>+ Add expense</button>
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => {
                startReview("expenses_irregular", REVIEW_PROMPTS.expenses_irregular, {
                  irregular_expenses: form.irregular_expenses,
                });
              }} style={btnPrimary}>Review with Clearpath →</button>
            </div>

            {reviews.expenses_irregular.status !== "idle" && (
              <ReviewPanel
                sectionId="expenses_irregular"
                review={reviews.expenses_irregular}
                onSendMessage={(msg) => sendReviewMessage("expenses_irregular", msg, REVIEW_PROMPTS.expenses_irregular, { irregular_expenses: form.irregular_expenses })}
                onConfirm={() => confirmReview("expenses_irregular")}
                onEdit={() => editSection("expenses_irregular", 3)}
              />
            )}
          </div>
        )}

        {/* STEP 4: Debts */}
        {step === 4 && (
          <div>
            {sectionHead("Your Debts", "List every debt — estimates are totally fine. We'll use these to build your payoff order.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {form.debts.map((d, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={{ color: "#22a89a", fontSize: 13, fontWeight: 700 }}>Debt #{i + 1}</span>
                    <button onClick={() => removeDebt(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20 }}>×</button>
                  </div>

                  {/* Type selector */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                    {[["credit_card", "💳 Credit Card"], ["student_loan", "🎓 Student Loan"], ["auto", "🚗 Auto"], ["mortgage", "🏠 Mortgage"], ["heloc", "🏡 HELOC"], ["personal", "💼 Personal"], ["medical", "🏥 Medical"], ["other", "📋 Other"]].map(([val, label]) => (
                      <button key={val} onClick={() => updateDebt(i, "type", val)} style={{ ...btnSecondary, fontSize: 11, padding: "4px 10px", background: d.type === val ? "#1e3a34" : "#0d2420", border: d.type === val ? "1px solid #22a89a" : "1px solid #1e3a34", color: d.type === val ? "#22a89a" : "#8cb8b4" }}>{label}</button>
                    ))}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Name / Nickname</label>
                      <input value={d.name} onChange={e => updateDebt(i, "name", e.target.value)} placeholder={d.type === "credit_card" ? "e.g. Chase Sapphire" : "e.g. Car loan"} style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Current Balance ($)</label>
                      <input type="number" value={d.balance} onChange={e => updateDebt(i, "balance", e.target.value)} placeholder="e.g. 8500" style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Interest Rate (%)</label>
                      <input type="number" value={d.rate} onChange={e => updateDebt(i, "rate", e.target.value)} placeholder="e.g. 22.99" style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>Min Monthly Payment ($)</label>
                      <input type="number" value={d.min} onChange={e => updateDebt(i, "min", e.target.value)} placeholder="e.g. 150" style={inputStyle} />
                    </div>
                    {d.type === "student_loan" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, gridColumn: "span 2" }}>
                        <label style={labelStyle}>
                          <input type="checkbox" checked={d.deferred} onChange={e => updateDebt(i, "deferred", e.target.checked)} style={{ marginRight: 6 }} />
                          Currently deferred
                        </label>
                        {d.deferred && (
                          <div style={{ display: "flex", gap: 10 }}>
                            <input type="number" value={d.deferred_until_month} onChange={e => updateDebt(i, "deferred_until_month", e.target.value)} placeholder="Month (1-12)" style={{ ...inputStyle, flex: 1 }} />
                            <input type="number" value={d.deferred_until_year} onChange={e => updateDebt(i, "deferred_until_year", e.target.value)} placeholder="Year (e.g. 2027)" style={{ ...inputStyle, flex: 1 }} />
                          </div>
                        )}
                      </div>
                    )}
                    {d.type === "heloc" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, gridColumn: "span 2" }}>
                        <label style={labelStyle}>
                          <input type="checkbox" checked={d.is_heloc_io} onChange={e => updateDebt(i, "is_heloc_io", e.target.checked)} style={{ marginRight: 6 }} />
                          Still in draw period (interest-only)
                        </label>
                        {d.is_heloc_io && (
                          <div style={{ display: "flex", gap: 10 }}>
                            <input type="number" value={d.heloc_draw_ends_month} onChange={e => updateDebt(i, "heloc_draw_ends_month", e.target.value)} placeholder="End month (1-12)" style={{ ...inputStyle, flex: 1 }} />
                            <input type="number" value={d.heloc_draw_ends_year} onChange={e => updateDebt(i, "heloc_draw_ends_year", e.target.value)} placeholder="End year (e.g. 2027)" style={{ ...inputStyle, flex: 1 }} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <button onClick={addDebt} style={btnPrimary}>+ Add a debt</button>

              {form.debts.length > 0 && (
                <div style={{ marginTop: 16, padding: "12px 16px", background: "#061410", borderRadius: 8, border: "1px solid #1e3a34" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ color: "#8cb8b4" }}>Total debt:</span>
                    <span style={{ color: "#f87171", fontWeight: 700 }}>${form.debts.reduce((a, d) => a + (parseFloat(d.balance) || 0), 0).toLocaleString()}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 4 }}>
                    <span style={{ color: "#8cb8b4" }}>Total minimums:</span>
                    <span style={{ color: "#e8c87a", fontWeight: 700 }}>${form.debts.reduce((a, d) => a + (parseFloat(d.min) || 0), 0).toLocaleString()}/mo</span>
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => startReview("debts", REVIEW_PROMPTS.debts, { debts: form.debts })} style={btnPrimary}>Review with Clearpath →</button>
            </div>

            {reviews.debts.status !== "idle" && (
              <ReviewPanel
                sectionId="debts"
                review={reviews.debts}
                onSendMessage={(msg) => sendReviewMessage("debts", msg, REVIEW_PROMPTS.debts, { debts: form.debts })}
                onConfirm={() => confirmReview("debts")}
                onEdit={() => editSection("debts", 4)}
              />
            )}
          </div>
        )}

        {/* STEP 5: Goals */}
        {step === 5 && (
          <div>
            {sectionHead("Goals & Commitment", "Almost there! Just a few questions about what matters most to you.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {groupHead("Priority")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
                {[
                  ["speed", "🏁 Speed", "Get debt free ASAP"],
                  ["save_interest", "💰 Save Money", "Pay least total interest"],
                  ["cash_flow", "📆 Free Cash Flow", "Lower bills quickly"],
                  ["balanced", "⚖️ Balanced", "Reasonable middle ground"],
                ].map(([val, label, sub]) => (
                  <button key={val} onClick={() => setForm(f => ({ ...f, priority: val }))} style={{ ...btnSecondary, padding: "12px 14px", textAlign: "left", background: form.priority === val ? "#1e3a34" : "#0d2420", border: form.priority === val ? "1px solid #22a89a" : "1px solid #1e3a34" }}>
                    <div style={{ color: form.priority === val ? "#22a89a" : "#e8f5f3", fontWeight: 700, fontSize: 13 }}>{label}</div>
                    <div style={{ color: "#8cb8b4", fontSize: 11, marginTop: 2 }}>{sub}</div>
                  </button>
                ))}
              </div>

              {groupHead("Emergency Fund")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Current Emergency Fund ($)</label>
                  <input type="number" value={form.emergency_fund_current} onChange={e => setForm(f => ({ ...f, emergency_fund_current: e.target.value }))} placeholder="0" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Target Emergency Fund ($)</label>
                  <input type="number" value={form.emergency_fund_target} onChange={e => setForm(f => ({ ...f, emergency_fund_target: e.target.value }))} placeholder="e.g. 15000" style={inputStyle} />
                </div>
              </div>

              {groupHead("Other Preferences")}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={form.open_to_refi} onChange={e => setForm(f => ({ ...f, open_to_refi: e.target.checked }))} />
                  <span style={{ color: "#c9e8e5", fontSize: 13 }}>I'm open to refinancing if it would save meaningful money</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Any debt you really want gone first? (emotional priority)</label>
                  <input value={form.emotional_priority} onChange={e => setForm(f => ({ ...f, emotional_priority: e.target.value }))} placeholder="e.g. 'Get rid of my Amex — I hate it'" style={inputStyle} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={labelStyle}>Any big upcoming expenses? (wedding, car, renovation, etc.)</label>
                  <input value={form.upcoming_expenses} onChange={e => setForm(f => ({ ...f, upcoming_expenses: e.target.value }))} placeholder="e.g. Wedding in 2026, ~$15k" style={inputStyle} />
                </div>
              </div>

              {groupHead("Monthly Commitment")}
              {(() => {
                const payload = buildPayload();
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ background: "#061410", borderRadius: 8, border: "1px solid #1e3a34", padding: "12px 16px", marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: "#8cb8b4" }}>Monthly take-home:</span>
                        <span style={{ color: "#22a89a", fontWeight: 700 }}>${payload.income.monthly_takehome.toLocaleString()}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: "#8cb8b4" }}>Monthly expenses (incl. annual ÷12):</span>
                        <span style={{ color: "#f87171", fontWeight: 700 }}>-${payload.expenses.total_monthly.toLocaleString()}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: "#8cb8b4" }}>Debt minimums:</span>
                        <span style={{ color: "#f87171", fontWeight: 700 }}>-${payload.total_minimums.toLocaleString()}</span>
                      </div>
                      <div style={{ borderTop: "1px solid #1e3a34", paddingTop: 8, marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                        <span style={{ color: "#e8c87a", fontWeight: 700 }}>True monthly surplus:</span>
                        <span style={{ color: payload.surplus - payload.total_minimums >= 0 ? "#22a89a" : "#f87171", fontWeight: 800 }}>
                          ${(payload.surplus - payload.total_minimums).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={labelStyle}>How much do you want to commit to debt payoff each month?</label>
                      <input type="number" value={form.monthly_committed} onChange={e => setForm(f => ({ ...f, monthly_committed: e.target.value }))} placeholder="Enter amount" style={inputStyle} />
                      <p style={{ fontSize: 11, color: "#8cb8b4", margin: 0, lineHeight: 1.6 }}>It's smart to keep a buffer — a plan that's too aggressive gets abandoned. Many people commit 80–90% of their surplus.</p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => startReview("goals", REVIEW_PROMPTS.goals, buildPayload())} style={btnPrimary}>Review with Clearpath →</button>
            </div>

            {reviews.goals.status !== "idle" && (
              <ReviewPanel
                sectionId="goals"
                review={reviews.goals}
                onSendMessage={(msg) => sendReviewMessage("goals", msg, REVIEW_PROMPTS.goals, buildPayload())}
                onConfirm={generatePlan}
                onEdit={() => editSection("goals", 5)}
              />
            )}

            {planError && <p style={{ color: "#f87171", fontSize: 13, marginTop: 12 }}>{planError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

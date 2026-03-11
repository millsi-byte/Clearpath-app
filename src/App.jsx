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

// ── Claude proxy call — routes through /api/claude to avoid CORS ─────────────
async function callClaude(systemPrompt, messages, max_tokens = 2000) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: systemPrompt,
      messages,
      max_tokens,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.text || "";
}

// ── Income validation flags (JS math — never delegated to Claude) ─────────────
function computeIncomeFlags(data) {
  return (data.earners || []).filter(e => {
    const takehome = parseFloat(e.takehome);
    const gross = parseFloat(e.gross_annual);
    return takehome > 0 && gross > 0 && takehome > gross / 12;
  }).map(e => {
    const takehome = parseFloat(e.takehome);
    const gross = parseFloat(e.gross_annual);
    const suggested = Math.round(takehome / 10);
    return `${e.label}'s monthly take-home is entered as $${takehome.toLocaleString()}, but their gross annual salary is only $${gross.toLocaleString()}/year — monthly take-home can't be more than someone earns before taxes.${suggested * 12 <= gross ? ` Did you mean $${suggested.toLocaleString()}?` : " Please double-check this figure."}`;
  });
}

const REVIEW_PROMPTS = {
  income: (data) => {
    const flags = computeIncomeFlags(data);
    return `You are Clearpath, a warm and encouraging debt payoff planning assistant. The user just filled out their income section.

INCOME DATA:
${JSON.stringify(data, null, 2)}

${flags.length > 0
  ? `MATH ERRORS DETECTED (pre-verified by the app — do not recalculate or rephrase):\n${flags.map(f => `- ${f}`).join("\n")}`
  : "MATH CHECK PASSED: All take-home figures are plausible. Do NOT flag any income numbers."}

Your job:
1. Warm 1-sentence acknowledgment using their name
2. List each earner's take-home EXACTLY as entered, total monthly take-home, any bonuses or stock grants
3. ${flags.length > 0 ? "Reproduce the MATH ERRORS above verbatim. Do not rephrase them." : "Do NOT flag or question any income numbers."}
4. End with "Does this look right, or anything to adjust?"`;
  },

  expenses_regular: (data) => `You are Clearpath, a warm and encouraging debt payoff planning assistant. The user just filled out their monthly expenses.

MONTHLY EXPENSES DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Give a warm 1-sentence acknowledgment using their name
2. Show a clean summary — group by category, list each non-zero expense, total at the bottom
3. Ask ONE clarifying question ONLY if something seems genuinely unusual. Otherwise just ask "Does this look right, or anything to adjust?"
4. Warm and conversational — never judgmental about any amount.`,

  expenses_irregular: (data) => `You are Clearpath, a warm and encouraging debt payoff planning assistant. The user just filled out their irregular/annual expenses.

IRREGULAR EXPENSES DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Give a warm 1-sentence acknowledgment
2. List each irregular expense with its amount, how it hits (spread or specific months), and its monthly equivalent
3. Show total annual cost and monthly equivalent (total / 12)
4. Ask "Does this look complete, or anything to add or adjust?"
5. Warm and conversational.`,

  debts: (data) => `You are Clearpath, a warm and encouraging debt payoff planning assistant. The user just filled out their debts.

DEBT DATA:
${JSON.stringify(data, null, 2)}

Your job:
1. Brief warm acknowledgment — normalize having debt, this is exactly why they're here
2. Clean debt summary: list each debt with name, balance, rate, and minimum payment. Show total debt and total minimum payments.
3. Flag ONLY clear data issues: a 0% rate on a credit card (promo rate?), a rate above 35% (confirm that's right), or a deferred loan with no activation date.
4. Ask "Does this list look complete? Anything to add or correct?"
5. Never make them feel bad about the amounts.`,

  goals: (data) => `You are Clearpath, a warm and encouraging debt payoff planning assistant. The user is about to finalize their monthly commitment.

COMPLETE FINANCIAL PICTURE:
${JSON.stringify(data, null, 2)}

This is the final section before building the plan. Your job:
1. Acknowledge they're almost done — just this last piece
2. Show their full financial picture clearly:
   "Here's where things stand, [name]:
   • Monthly take-home: $X
   • Monthly expenses (including $X/mo set aside for annual costs): $X
   • Minimum debt payments: $X/mo
   • True monthly surplus after everything: $X"
3. If surplus is positive: explain that's what's available to attack debt, and that they don't have to commit all of it — keeping a buffer is smart
4. If surplus is zero or negative: be honest but warm — explain what it means and that you'll still build a plan
5. Ask: "What amount feels sustainable to commit to debt payoff each month?"
6. Do NOT answer the commitment question for them — just set the context and ask.`,
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
      const cells = line.split("|").filter((_, idx) => idx > 0 && idx < line.split("|").length - 1);
      const isHeader = lines[i + 1]?.startsWith("|---");
      const isSeparator = line.includes("|---");
      if (!isSeparator) {
        elements.push(
          <div key={i} style={{ display: "flex", gap: 1, marginBottom: 1 }}>
            {cells.map((c, j) => (
              <div key={j} style={{
                flex: 1, padding: "4px 8px",
                background: isHeader ? "#0f3330" : "#0d2420",
                color: isHeader ? "#22a89a" : "#c9e8e5",
                fontSize: isHeader ? 11 : 12,
                fontWeight: isHeader ? 700 : 400,
                minWidth: 0, wordBreak: "break-word"
              }}>
                {c.trim().replace(/\*\*/g, "")}
              </div>
            ))}
          </div>
        );
      }
    } else if (line.trim() === "---") {
      elements.push(<hr key={i} style={{ border: "none", borderTop: "1px solid #1e3a34", margin: "16px 0" }} />);
    } else if (line.trim()) {
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

// ── Review Panel ──────────────────────────────────────────────────────────────
function ReviewPanel({ review, onConfirm, onEdit, flags = [] }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [review.messages]);

  const hasFlags = flags.length > 0;

  return (
    <div style={{ marginTop: 20, borderRadius: 12, border: `1px solid ${hasFlags ? "#7f1d1d" : "#1e3a34"}`, overflow: "hidden" }}>
      <div style={{ background: hasFlags ? "#450a0a" : "#0d2420", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14 }}>{hasFlags ? "🚨" : "🤖"}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: hasFlags ? "#fca5a5" : "#22a89a" }}>
          {hasFlags ? "Error — Please Correct Before Continuing" : "Clearpath Review"}
        </span>
      </div>

      {hasFlags && (
        <div style={{ background: "#3b0a0a", borderBottom: "1px solid #7f1d1d", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {flags.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ color: "#f87171", fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚠️</span>
              <span style={{ color: "#fecaca", fontSize: 13, lineHeight: 1.6, fontWeight: 600 }}>{f}</span>
            </div>
          ))}
          <div style={{ marginTop: 4, padding: "10px 12px", background: "#450a0a", borderRadius: 8, border: "1px solid #7f1d1d" }}>
            <p style={{ color: "#fca5a5", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
              👇 <strong>To fix this:</strong> Click <em>"Go back and correct my answers"</em> below, update the highlighted field, then click <em>"Review with Clearpath"</em> again.
            </p>
          </div>
        </div>
      )}

      <div style={{ background: "#0a1f1c", padding: 14, display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflowY: "auto" }}>
        {review.messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "88%", padding: "9px 13px",
              borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
              background: m.role === "user" ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e293b",
              color: "#f1f5f9", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {review.loading && (
          <div style={{ display: "flex" }}>
            <div style={{ background: "#1e293b", borderRadius: "12px 12px 12px 3px", padding: "9px 13px" }}>
              <span style={{ color: "#8cb8b4", fontSize: 12 }}>Clearpath is reviewing…</span>
            </div>
          </div>
        )}
        {review.error && (
          <div style={{ background: "#2d1515", borderRadius: 8, padding: "8px 12px", border: "1px solid #5c2020" }}>
            <span style={{ color: "#f87171", fontSize: 12 }}>⚠️ {review.error} — please try again.</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {review.status !== "confirmed" && !review.loading && (
        <div style={{ padding: 10, borderTop: `1px solid ${hasFlags ? "#7f1d1d" : "#1e3a34"}`, background: hasFlags ? "#450a0a" : "#0d2420", display: "flex", flexDirection: "column", gap: 8 }}>
          {!hasFlags && (
            <button onClick={onConfirm} style={{ background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 7, color: "white", fontSize: 13, fontWeight: 600, padding: "11px 12px", cursor: "pointer" }}>
              ✅ Looks right, continue →
            </button>
          )}
          <button onClick={onEdit} style={{ background: hasFlags ? "#7f1d1d" : "#0f3330", border: `1px solid ${hasFlags ? "#ef4444" : "#1e3a34"}`, borderRadius: 7, color: hasFlags ? "#fecaca" : "#8cb8b4", fontSize: 12, fontWeight: hasFlags ? 600 : 400, padding: "8px 12px", cursor: "pointer" }}>
            {hasFlags ? "✏️ Go back and correct my answers" : "✏️ Go back and correct my answers"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Month names ───────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ── Stock type field definitions ──────────────────────────────────────────────
// Each type gets its own relevant fields shown in the form
const STOCK_TYPES = ["RSU", "ESPP", "Options", "Dividend"];

function StockGrantFields({ grant, index, updateFn }) {
  const iStyle = { background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#e8f5f3", fontSize: 13, padding: "9px 12px", outline: "none", width: "100%", boxSizing: "border-box" };
  const lStyle = { fontSize: 12, color: "#c9e8e5", fontWeight: 600 };
  const field = (label, key, type = "text", placeholder = "", hint = null) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={lStyle}>{label}</label>
      <input type={type} value={grant[key] || ""} onChange={e => updateFn(index, key, e.target.value)} placeholder={placeholder} style={iStyle} />
      {hint && <span style={{ fontSize: 11, color: "#22a89a" }}>{hint}</span>}
    </div>
  );
  const selectField = (label, key, options) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={lStyle}>{label}</label>
      <select value={grant[key] || ""} onChange={e => updateFn(index, key, e.target.value)} style={iStyle}>
        {options.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}
      </select>
    </div>
  );

  if (grant.type === "RSU") {
    const perVest = grant.total_amount && grant.vest_frequency && grant.vest_duration
      ? Math.round((parseFloat(grant.total_amount) / Math.floor(parseInt(grant.vest_duration) / parseInt(grant.vest_frequency))) * (1 - (parseFloat(grant.tax_withholding) || 22) / 100))
      : null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={lStyle}>Grant Date</label>
          <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Format: MM/YYYY</span>
          <input type="text" value={grant.grant_date || ""} onChange={e => updateFn(index, "grant_date", e.target.value)} placeholder="e.g. 03/2024" maxLength={7} style={iStyle} />
        </div>
        {field("Total Grant Value ($)", "total_amount", "number", "e.g. 40000")}
        {selectField("Vest Every", "vest_frequency", [["3","Quarterly (3 mo)"],["6","Semi-annual (6 mo)"],["12","Annual (12 mo)"],["1","Monthly"]])}
        {selectField("Vesting Duration", "vest_duration", [["12","1 year"],["24","2 years"],["36","3 years"],["48","4 years"],["60","5 years"]])}
        {field("Tax Withholding %", "tax_withholding", "number", "22")}
        {perVest && (
          <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 8 }}>
            <span style={{ fontSize: 11, color: "#22a89a" }}>≈ ${perVest.toLocaleString()} after-tax per vest</span>
          </div>
        )}
      </div>
    );
  }

  if (grant.type === "ESPP") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <p style={{ gridColumn: "span 2", color: "#8cb8b4", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          ESPP: you buy company stock at a discount through payroll deductions. The discount is your windfall.
        </p>
        {field("Payroll Deduction ($/mo)", "espp_deduction_monthly", "number", "e.g. 200", "Money leaving your paycheck each month")}
        {field("Discount %", "espp_discount_pct", "number", "e.g. 15", "Typical plans offer 10–15% discount")}
        {selectField("Purchase Period", "espp_period", [["6","Every 6 months"],["12","Annually"],["3","Quarterly"]])}
        {grant.espp_deduction_monthly && grant.espp_discount_pct && grant.espp_period && (() => {
          const contribution = parseFloat(grant.espp_deduction_monthly) * parseInt(grant.espp_period);
          const gain = Math.round(contribution * (parseFloat(grant.espp_discount_pct) / 100) * 0.85);
          return (
            <div style={{ gridColumn: "span 2", fontSize: 11, color: "#22a89a" }}>
              ≈ ${gain.toLocaleString()} after-tax gain per purchase period
            </div>
          );
        })()}
      </div>
    );
  }

  if (grant.type === "Options") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <p style={{ gridColumn: "span 2", color: "#8cb8b4", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          Stock options give you the right to buy shares at a set price (strike price). They're only valuable if the stock is above the strike price.
        </p>
        {field("Number of Options", "options_count", "number", "e.g. 5000")}
        {field("Strike Price ($ per share)", "options_strike", "number", "e.g. 12.50")}
        {field("Current Stock Price ($ per share)", "options_current_price", "number", "e.g. 18.00")}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={lStyle}>Expiration Date</label>
          <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Format: MM/YYYY</span>
          <input type="text" value={grant.options_expiry || ""} onChange={e => updateFn(index, "options_expiry", e.target.value)} placeholder="e.g. 06/2027" maxLength={7} style={iStyle} />
        </div>
        {grant.options_count && grant.options_strike && grant.options_current_price && (() => {
          const spread = parseFloat(grant.options_current_price) - parseFloat(grant.options_strike);
          if (spread <= 0) return <div style={{ gridColumn: "span 2", fontSize: 11, color: "#f87171" }}>⚠️ Currently underwater (stock below strike price) — no immediate value</div>;
          const gross = spread * parseInt(grant.options_count);
          const afterTax = Math.round(gross * 0.72);
          return <div style={{ gridColumn: "span 2", fontSize: 11, color: "#22a89a" }}>≈ ${afterTax.toLocaleString()} after-tax if exercised today at current price</div>;
        })()}
      </div>
    );
  }

  if (grant.type === "Dividend") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <p style={{ gridColumn: "span 2", color: "#8cb8b4", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          Dividends are regular cash payments from stocks or funds you own.
        </p>
        {field("Stock or Fund Name", "dividend_ticker", "text", "e.g. VYM, Apple")}
        {field("Amount Per Payment ($)", "dividend_amount", "number", "e.g. 250")}
        {selectField("Payment Frequency", "dividend_frequency", [["quarterly","Quarterly"],["monthly","Monthly"],["annually","Annually"],["semiannually","Semi-annually"]])}
        {grant.dividend_amount && grant.dividend_frequency && (() => {
          const mult = { quarterly: 4, monthly: 12, annually: 1, semiannually: 2 }[grant.dividend_frequency] || 4;
          const annual = parseFloat(grant.dividend_amount) * mult;
          return <div style={{ gridColumn: "span 2", fontSize: 11, color: "#22a89a" }}>≈ ${Math.round(annual).toLocaleString()}/yr (${Math.round(annual / 12)}/mo equivalent)</div>;
        })()}
      </div>
    );
  }

  return null;
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("code");
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "",
    // Per-person earners (replaces flat gross_annual / monthly_takehome / partner_income)
    earners: [{ label: "", gross_annual: "", takehome: "" }],
    // Per-person bonuses (one entry per earner, synced by index)
    bonuses: [{ type: "none", amount: "", percent: "", month: "December" }],
    other_income: "",
    extra_income: [],
    // Stock grants: each has a `type` field (RSU/ESPP/Options/Dividend) plus type-specific fields
    stock_grants: [],
    rent: "", mortgage: "", property_tax: "", hoa: "", renters_insurance: "",
    electric_gas: "", water: "", internet: "",
    streaming_video: "", streaming_music: "", other_subscriptions: "",
    cell_phone: "",
    car_payment: "", car_insurance_monthly: "", gas: "", parking_tolls: "",
    groceries: "", dining_out: "",
    health_insurance: "", life_insurance: "", dental_vision: "", medical_copays: "",
    childcare: "", child_support_paid: "", pets: "", personal_care: "", gym: "",
    savings_transfers: "", misc_buffer: "", other_monthly: "",
    custom_monthly_expenses: [],
    irregular_expenses: [],
    extra_annual: [],
    debts: [],
    priority: "balanced",
    emergency_fund_current: "",
    emergency_fund_target: "",
    open_to_refi: false,
    emotional_priority: "",
    upcoming_expenses: "",
    monthly_committed: "",
  });

  const [reviews, setReviews] = useState({
    income: { status: "idle", messages: [], loading: false, error: null },
    expenses_regular: { status: "idle", messages: [], loading: false, error: null },
    expenses_irregular: { status: "idle", messages: [], loading: false, error: null },
    debts: { status: "idle", messages: [], loading: false, error: null },
    goals: { status: "idle", messages: [], loading: false, error: null },
  });

  const [planText, setPlanText] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const [qaMessages, setQaMessages] = useState([]);
  const [qaInput, setQaInput] = useState("");
  const [qaLoading, setQaLoading] = useState(false);
  const qaEndRef = useRef(null);
  useEffect(() => { qaEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [qaMessages]);

  // ── Access code ──────────────────────────────────────────────────────────────
  async function checkCode() {
    setCodeLoading(true); setCodeError("");
    try {
      const res = await sbFetch(`access_codes?code=eq.${encodeURIComponent(codeInput.trim().toUpperCase())}&select=code`);
      const data = await res.json();
      if (!data?.length) { setCodeError("Code not found. Check your confirmation email."); setCodeLoading(false); return; }
      setScreen("interview");
    } catch {
      setCodeError("Connection error. Please try again.");
    }
    setCodeLoading(false);
  }

  // ── Review state management ──────────────────────────────────────────────────
  async function startReview(sectionId, promptFn, data, flags = []) {
    setReviews(r => ({ ...r, [sectionId]: { status: "active", messages: [], loading: true, error: null, flags } }));
    try {
      const reply = await callClaude(promptFn(data), [{ role: "user", content: "Please review my data." }]);
      setReviews(r => ({
        ...r,
        [sectionId]: { status: "ready_to_confirm", messages: [{ role: "assistant", content: reply }], loading: false, error: null, flags: r[sectionId].flags || [] },
      }));
    } catch (err) {
      setReviews(r => ({
        ...r,
        [sectionId]: { ...r[sectionId], loading: false, error: err.message },
      }));
    }
  }

  function confirmReview(sectionId) {
    setReviews(r => ({ ...r, [sectionId]: { ...r[sectionId], status: "confirmed" } }));
    setStep(s => s + 1);
  }

  function editSection(sectionId, stepNum) {
    setReviews(r => ({ ...r, [sectionId]: { status: "idle", messages: [], loading: false, error: null } }));
    setStep(stepNum);
  }

  // ── Build payload for plan generation ────────────────────────────────────────
  function buildPayload() {
    const f = form;

    // Sum all earner take-homes
    const monthlyIn = f.earners.reduce((s, e) => s + (parseFloat(e.takehome) || 0), 0)
      + (parseFloat(f.other_income) || 0)
      + f.extra_income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    // Build bonus windfalls per earner
    const bonusWindfalls = f.bonuses
      .map((bonus, i) => {
        const earner = f.earners[i];
        if (!earner || bonus.type === "none") return null;
        const gross = parseFloat(earner.gross_annual) || 0;
        const pre = bonus.type === "percent"
          ? gross * (parseFloat(bonus.percent) || 0) / 100
          : parseFloat(bonus.amount) || 0;
        const afterTax = Math.round(pre * 0.72);
        if (!afterTax) return null;
        return { name: `${earner.label || `Earner #${i+1}`} Bonus`, amount: afterTax, month: bonus.month };
      })
      .filter(Boolean);

    // Build stock windfalls from type-specific fields
    const stockWindfalls = f.stock_grants.map(g => {
      if (g.type === "RSU") {
        const total = parseFloat(g.total_amount) || 0;
        const freq = parseInt(g.vest_frequency) || 12;
        const dur = parseInt(g.vest_duration) || 48;
        const count = Math.floor(dur / freq);
        const perVest = Math.round(total / count * (1 - (parseFloat(g.tax_withholding) || 22) / 100));
        return { type: "RSU", name: "RSU", per_event: perVest, frequency_months: freq, grant_date: g.grant_date };
      }
      if (g.type === "ESPP") {
        const contribution = (parseFloat(g.espp_deduction_monthly) || 0) * (parseInt(g.espp_period) || 6);
        const gain = Math.round(contribution * (parseFloat(g.espp_discount_pct) || 15) / 100 * 0.85);
        return { type: "ESPP", name: "ESPP", per_event: gain, frequency_months: parseInt(g.espp_period) || 6, monthly_deduction: parseFloat(g.espp_deduction_monthly) || 0 };
      }
      if (g.type === "Options") {
        const spread = (parseFloat(g.options_current_price) || 0) - (parseFloat(g.options_strike) || 0);
        const gross = Math.max(0, spread) * (parseInt(g.options_count) || 0);
        return { type: "Options", name: "Stock Options", potential_value: Math.round(gross * 0.72), strike: g.options_strike, current_price: g.options_current_price, expiry: g.options_expiry };
      }
      if (g.type === "Dividend") {
        const mult = { quarterly: 4, monthly: 12, annually: 1, semiannually: 2 }[g.dividend_frequency] || 4;
        return { type: "Dividend", name: g.dividend_ticker || "Dividend", per_event: parseFloat(g.dividend_amount) || 0, frequency_months: Math.round(12 / mult) };
      }
      return null;
    }).filter(Boolean);

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
      .filter(e => e.amount > 0)
      .concat(
        (f.custom_monthly_expenses || [])
          .filter(e => e.name && parseFloat(e.amount) > 0)
          .map(e => ({ name: e.name, amount: parseFloat(e.amount), category: e.category }))
      );

    const irregularExp = f.irregular_expenses
      .filter(e => e.name)
      .map(e => {
        const annual = e.mode === "spread"
          ? parseFloat(e.annual_total) || 0
          : e.entries.reduce((s, en) => s + (parseFloat(en.amount) || 0), 0);
        return {
          name: e.name, amount: annual, mode: e.mode,
          months: e.mode === "spread" ? [1,2,3,4,5,6,7,8,9,10,11,12] : e.entries.map(en => parseInt(en.month)),
        };
      });

    const monthlyIrreg = irregularExp.reduce((a, e) => a + e.amount, 0) / 12;
    const totalExp = regularExp.reduce((a, e) => a + e.amount, 0) + monthlyIrreg;
    const totalMins = f.debts.reduce((a, d) => a + (parseFloat(d.min) || 0), 0);
    const committed = parseFloat(f.monthly_committed) || 0;

    return {
      name: f.name || "there",
      today: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      income: {
        monthly_takehome: monthlyIn,
        earners: f.earners.map((e, i) => ({
          label: e.label || `Earner #${i+1}`,
          gross_annual: parseFloat(e.gross_annual) || 0,
          takehome: parseFloat(e.takehome) || 0,
        })),
        bonuses: bonusWindfalls,
        stock_windfalls: stockWindfalls,
        other_monthly: parseFloat(f.other_income) || 0,
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
        is_heloc_io: d.is_heloc_io || false,
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
    try {
      const payload = buildPayload();
      const reply = await callClaude(PLAN_SYSTEM_PROMPT, [{ role: "user", content: JSON.stringify(payload, null, 2) }], 3000);
      setPlanText(reply);
      setScreen("plan");
    } catch (err) {
      setPlanError("Plan generation failed: " + err.message);
    }
    setPlanLoading(false);
  }

  async function sendQA() {
    if (!qaInput.trim() || qaLoading) return;
    const msg = qaInput; setQaInput(""); setQaLoading(true);
    const history = [...qaMessages, { role: "user", content: msg }];
    setQaMessages(history);
    try {
      const payload = buildPayload();
      const reply = await callClaude(
        PLAN_SYSTEM_PROMPT + "\n\nOriginal plan:\n" + planText + "\n\nUser data:\n" + JSON.stringify(payload),
        history, 2000
      );
      setQaMessages(h => [...h, { role: "assistant", content: reply }]);
    } catch (err) {
      setQaMessages(h => [...h, { role: "assistant", content: "Sorry, something went wrong. Please try again." }]);
    }
    setQaLoading(false);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function addDebt() {
    setForm(f => ({ ...f, debts: [...f.debts, { name: "", balance: "", rate: "", min: "", type: "credit_card", is_heloc_io: false, heloc_draw_ends_month: "", heloc_draw_ends_year: "", deferred: false, deferred_until_month: "", deferred_until_year: "" }] }));
  }
  function updateDebt(i, k, v) { setForm(f => { const d = [...f.debts]; d[i] = { ...d[i], [k]: v }; return { ...f, debts: d }; }); }
  function removeDebt(i) { setForm(f => ({ ...f, debts: f.debts.filter((_, idx) => idx !== i) })); }

  function addExtraIncome() { setForm(f => ({ ...f, extra_income: [...f.extra_income, { name: "", amount: "" }] })); }
  function updateExtraIncome(i, k, v) { setForm(f => { const ei = [...f.extra_income]; ei[i] = { ...ei[i], [k]: v }; return { ...f, extra_income: ei }; }); }
  function removeExtraIncome(i) { setForm(f => ({ ...f, extra_income: f.extra_income.filter((_, idx) => idx !== i) })); }

  function addStockGrant() { setForm(f => ({ ...f, stock_grants: [...f.stock_grants, { type: "RSU", grant_date: "", total_amount: "", vest_frequency: "12", vest_duration: "48", tax_withholding: "22" }] })); }  function updateStockGrant(i, k, v) { setForm(f => { const sg = [...f.stock_grants]; sg[i] = { ...sg[i], [k]: v }; return { ...f, stock_grants: sg }; }); }
  function removeStockGrant(i) { setForm(f => ({ ...f, stock_grants: f.stock_grants.filter((_, idx) => idx !== i) })); }

  function addIrregularExpense() { setForm(f => ({ ...f, irregular_expenses: [...f.irregular_expenses, { name: "", mode: "spread", annual_total: "", entries: [{ month: "1", amount: "" }] }] })); }
  function updateIrregularExpense(i, k, v) { setForm(f => { const ie = [...f.irregular_expenses]; ie[i] = { ...ie[i], [k]: v }; return { ...f, irregular_expenses: ie }; }); }
  function removeIrregularExpense(i) { setForm(f => ({ ...f, irregular_expenses: f.irregular_expenses.filter((_, idx) => idx !== i) })); }
  function addIrregularEntry(i) { setForm(f => { const ie = [...f.irregular_expenses]; ie[i] = { ...ie[i], entries: [...ie[i].entries, { month: "1", amount: "" }] }; return { ...f, irregular_expenses: ie }; }); }
  function updateIrregularEntry(i, j, k, v) { setForm(f => { const ie = [...f.irregular_expenses]; const entries = [...ie[i].entries]; entries[j] = { ...entries[j], [k]: v }; ie[i] = { ...ie[i], entries }; return { ...f, irregular_expenses: ie }; }); }
  function removeIrregularEntry(i, j) { setForm(f => { const ie = [...f.irregular_expenses]; ie[i] = { ...ie[i], entries: ie[i].entries.filter((_, idx) => idx !== j) }; return { ...f, irregular_expenses: ie }; }); }

  function addCustomMonthly(category) { setForm(f => ({ ...f, custom_monthly_expenses: [...f.custom_monthly_expenses, { category, name: "", amount: "" }] })); }
  function updateCustomMonthly(i, k, v) { setForm(f => { const c = [...f.custom_monthly_expenses]; c[i] = { ...c[i], [k]: v }; return { ...f, custom_monthly_expenses: c }; }); }
  function removeCustomMonthly(i) { setForm(f => ({ ...f, custom_monthly_expenses: f.custom_monthly_expenses.filter((_, idx) => idx !== i) })); }

  // ── Shared styles ─────────────────────────────────────────────────────────────
  const iS = { background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#e8f5f3", fontSize: 13, padding: "9px 12px", outline: "none", width: "100%", boxSizing: "border-box" };
  const lS = { fontSize: 12, color: "#c9e8e5", fontWeight: 600 };
  const btnP = { background: "linear-gradient(135deg,#1A7A6E,#22a89a)", border: "none", borderRadius: 8, color: "white", fontSize: 13, fontWeight: 600, padding: "11px 20px", cursor: "pointer" };
  const btnS = { background: "#0d2420", border: "1px solid #1e3a34", borderRadius: 8, color: "#8cb8b4", fontSize: 13, padding: "9px 16px", cursor: "pointer" };

  const sectionHead = (title, sub) => (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ color: "#e8c87a", fontSize: 18, fontWeight: 700, margin: 0 }}>{title}</h2>
      {sub && <p style={{ color: "#8cb8b4", fontSize: 13, margin: "4px 0 0" }}>{sub}</p>}
    </div>
  );
  const groupHead = (title) => (
    <div style={{ borderBottom: "1px solid #1e3a34", paddingBottom: 6, marginBottom: 14, marginTop: 24 }}>
      <span style={{ color: "#22a89a", fontSize: 12, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase" }}>{title}</span>
    </div>
  );

  const STEPS = ["Welcome", "Income", "Monthly Expenses", "Annual Expenses", "Debts", "Goals"];

  // ────────────────────────────────────────────────────────────────────────────
  // CODE SCREEN
  // ────────────────────────────────────────────────────────────────────────────
  if (screen === "code") {
    return (
      <div style={{ minHeight: "100vh", background: "#07120f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'Inter', sans-serif" }}>
        <div style={{ maxWidth: 420, width: "100%" }}>
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
            <h2 style={{ color: "#e8f5f3", fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Let's get started</h2>
            <p style={{ color: "#8cb8b4", fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>Enter the access code from your confirmation email to begin.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                value={codeInput} onChange={e => setCodeInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && checkCode()}
                placeholder="CLEARXXXX"
                style={{ ...iS, fontSize: 15, padding: "12px 16px", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}
              />
              {codeError && <p style={{ color: "#f87171", fontSize: 12, margin: 0 }}>{codeError}</p>}
              <button onClick={checkCode} disabled={codeLoading || !codeInput.trim()} style={{ ...btnP, padding: "13px", fontSize: 14, opacity: codeLoading || !codeInput.trim() ? 0.5 : 1 }}>
                {codeLoading ? "Checking…" : "Enter →"}
              </button>
            </div>
            <p style={{ color: "#475569", fontSize: 12, marginTop: 20, textAlign: "center" }}>Your access code was included in your order confirmation email.</p>
          </div>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PLAN SCREEN
  // ────────────────────────────────────────────────────────────────────────────
  if (screen === "plan") {
    const payload = buildPayload();
    return (
      <div style={{ minHeight: "100vh", background: "#07120f", fontFamily: "'Inter', sans-serif" }}>
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
          <div style={{ paddingRight: 24 }}>
            {planLoading ? (
              <div style={{ color: "#8cb8b4", padding: 40, textAlign: "center" }}>Calculating your plan…</div>
            ) : (
              <div>{renderMd(planText)}</div>
            )}
          </div>
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
                    <button key={q} onClick={() => setQaInput(q)} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 7, color: "#8cb8b4", fontSize: 11, padding: "7px 11px", cursor: "pointer", textAlign: "left" }}>{q}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // INTERVIEW SCREEN
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#07120f", fontFamily: "'Inter', sans-serif" }}>
      {/* Step header */}
      <div style={{ background: "#0d2420", borderBottom: "1px solid #1e3a34", padding: "12px 24px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ fontSize: 18 }}>🧭</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: "#e8f5f3" }}>Clearpath</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: i < step ? "#22a89a" : i === step ? "linear-gradient(135deg,#1A7A6E,#22a89a)" : "#1e3a34", fontSize: 10, fontWeight: 700, color: i <= step ? "white" : "#475569" }}>
                {i < step ? "✓" : i + 1}
              </div>
              {i < STEPS.length - 1 && <div style={{ width: 16, height: 1, background: i < step ? "#22a89a" : "#1e3a34" }} />}
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 24px" }}>

        {/* ── STEP 1: Income ── */}
        {step === 1 && (
          <div>
            {sectionHead("Income", "Let's start with your household income.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {groupHead("Household Earners")}
              <p style={{ fontSize: 12, color: "#8cb8b4", margin: "-8px 0 14px", lineHeight: 1.6 }}>
                Enter each person separately. Base salary only — no bonuses or stock yet (we'll capture those below).
              </p>
              {form.earners.map((earner, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 14, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ color: "#22a89a", fontSize: 12, fontWeight: 700 }}>Earner #{i + 1}</span>
                    {i > 0 && <button onClick={() => setForm(f => ({ ...f, earners: f.earners.filter((_, idx) => idx !== i) }))} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Your Name {i === 0 && <span style={{ color: "#f87171" }}>*</span>}</label>
                      <input value={earner.label} onChange={e => { const ea = [...form.earners]; ea[i] = { ...ea[i], label: e.target.value }; setForm(f => ({ ...f, earners: ea })); }} placeholder={i === 0 ? "e.g. Scott" : "e.g. Sarah"} style={{ ...iS, border: i === 0 && !earner.label ? "1px solid #f87171" : "1px solid #1e3a34" }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Gross Annual Base Salary</label>
                      <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Before taxes, base only</span>
                      <input type="number" value={earner.gross_annual} onChange={e => { const ea = [...form.earners]; ea[i] = { ...ea[i], gross_annual: e.target.value }; setForm(f => ({ ...f, earners: ea })); }} placeholder="e.g. 75000" style={iS} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Monthly Take-Home</label>
                      <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>After taxes, into bank</span>
                      <input type="number" value={earner.takehome} onChange={e => { const ea = [...form.earners]; ea[i] = { ...ea[i], takehome: e.target.value }; setForm(f => ({ ...f, earners: ea })); }} placeholder="e.g. 4500" style={iS} />
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={() => setForm(f => ({ ...f, earners: [...f.earners, { label: "", gross_annual: "", takehome: "" }], bonuses: [...f.bonuses, { type: "none", amount: "", percent: "", month: "December" }] }))} style={{ ...btnS, fontSize: 12, marginBottom: 4 }}>+ Add another earner</button>

              {groupHead("Other Monthly Income")}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={lS}>Other Monthly Income</label>
                <span style={{ fontSize: 11, color: "#8cb8b4" }}>Rental income, freelance, Social Security, alimony received, etc.</span>
                <input type="number" value={form.other_income} onChange={e => setForm(f => ({ ...f, other_income: e.target.value }))} placeholder="e.g. 500 (or leave blank)" style={{ ...iS, maxWidth: 220 }} />
              </div>

              {groupHead("Bonuses")}
              <p style={{ fontSize: 12, color: "#8cb8b4", margin: "-8px 0 14px" }}>Add a bonus for each earner who receives one. Leave blank if none.</p>
              {form.bonuses.map((bonus, i) => {
                const earnerLabel = form.earners[i]?.label || `Earner #${i + 1}`;
                const earnerGross = parseFloat(form.earners[i]?.gross_annual) || 0;
                return (
                  <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 14, marginBottom: 12 }}>
                    <div style={{ marginBottom: 10, fontSize: 12, color: "#22a89a", fontWeight: 700 }}>{earnerLabel}'s Bonus</div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                      {["none","amount","percent"].map(t => (
                        <button key={t} onClick={() => { const b = [...form.bonuses]; b[i] = { ...b[i], type: t }; setForm(f => ({ ...f, bonuses: b })); }}
                          style={{ ...btnS, flex: 1, fontSize: 11, background: bonus.type === t ? "#1e3a34" : "#0d2420", border: bonus.type === t ? "1px solid #22a89a" : "1px solid #1e3a34", color: bonus.type === t ? "#22a89a" : "#8cb8b4" }}>
                          {t === "none" ? "No bonus" : t === "amount" ? "$ Fixed amount" : "% of salary"}
                        </button>
                      ))}
                    </div>
                    {bonus.type !== "none" && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        {bonus.type === "amount" ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            <label style={lS}>Bonus Amount (pre-tax)</label>
                            <input type="number" value={bonus.amount} onChange={e => { const b = [...form.bonuses]; b[i] = { ...b[i], amount: e.target.value }; setForm(f => ({ ...f, bonuses: b })); }} placeholder="e.g. 8000" style={iS} />
                            {bonus.amount && <span style={{ fontSize: 11, color: "#22a89a" }}>≈ ${Math.round(parseFloat(bonus.amount) * 0.72).toLocaleString()} after ~28% tax</span>}
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            <label style={lS}>Bonus % of {earnerLabel}'s Gross Salary</label>
                            <input type="number" value={bonus.percent} onChange={e => { const b = [...form.bonuses]; b[i] = { ...b[i], percent: e.target.value }; setForm(f => ({ ...f, bonuses: b })); }} placeholder="e.g. 10" style={iS} />
                            {bonus.percent && earnerGross > 0 && <span style={{ fontSize: 11, color: "#22a89a" }}>≈ ${Math.round(earnerGross * parseFloat(bonus.percent) / 100 * 0.72).toLocaleString()} after ~28% tax</span>}
                          </div>
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          <label style={lS}>Typical Bonus Month</label>
                          <select value={bonus.month} onChange={e => { const b = [...form.bonuses]; b[i] = { ...b[i], month: e.target.value }; setForm(f => ({ ...f, bonuses: b })); }} style={iS}>
                            {MONTH_FULL.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {groupHead("Stock Compensation")}
              <p style={{ fontSize: 12, color: "#8cb8b4", marginBottom: 14 }}>
                RSUs, ESPP, stock options, or dividends? Add each one separately. Each type has different fields.
              </p>
              {form.stock_grants.map((g, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      {STOCK_TYPES.map(t => (
                        <button key={t} onClick={() => updateStockGrant(i, "type", t)} style={{ ...btnS, padding: "4px 10px", fontSize: 11, background: g.type === t ? "#1e3a34" : "#0d2420", border: g.type === t ? "1px solid #22a89a" : "1px solid #1e3a34", color: g.type === t ? "#22a89a" : "#8cb8b4" }}>{t}</button>
                      ))}
                    </div>
                    <button onClick={() => removeStockGrant(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20 }}>×</button>
                  </div>
                  <StockGrantFields grant={g} index={i} updateFn={updateStockGrant} />
                </div>
              ))}
              <button onClick={addStockGrant} style={{ ...btnS, fontSize: 12 }}>+ Add stock compensation</button>

              {groupHead("Additional Income Sources")}
              {form.extra_income.map((ei, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 140px 32px", gap: 10, marginBottom: 10 }}>
                  <input value={ei.name} onChange={e => updateExtraIncome(i, "name", e.target.value)} placeholder="Source name" style={iS} />
                  <input type="number" value={ei.amount} onChange={e => updateExtraIncome(i, "amount", e.target.value)} placeholder="$/month" style={iS} />
                  <button onClick={() => removeExtraIncome(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20 }}>×</button>
                </div>
              ))}
              <button onClick={addExtraIncome} style={{ ...btnS, fontSize: 12 }}>+ Add income source</button>
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => {
                if (!form.earners[0]?.label?.trim()) { alert("Please enter your name."); return; }
                if (!form.earners[0]?.takehome) { alert("Please enter your monthly take-home pay."); return; }
                const data = { name: form.earners[0]?.label || "there", earners: form.earners, bonuses: form.bonuses, other_income: form.other_income, extra_income: form.extra_income, stock_grants: form.stock_grants };
                const incomeFlags = computeIncomeFlags(data);
                startReview("income", REVIEW_PROMPTS.income, data, incomeFlags);
              }} style={btnP}>Review with Clearpath →</button>
            </div>
            {reviews.income.status !== "idle" && (reviews.income.messages.length > 0 || reviews.income.loading || reviews.income.error) && (
              <ReviewPanel review={reviews.income}
                flags={reviews.income.flags || []}
                onConfirm={() => confirmReview("income")}
                onEdit={() => editSection("income", 1)} />
            )}
          </div>
        )}

        {/* ── STEP 2: Monthly Expenses ── */}
        {step === 2 && (
          <div>
            {sectionHead("Monthly Expenses", "Monthly recurring costs only — things that hit every single month for roughly the same amount.")}
            <div style={{ background: "#0a1f1c", border: "1px solid #22a89a", borderRadius: 10, padding: "12px 16px", marginBottom: 18 }}>
              <p style={{ color: "#c9e8e5", fontSize: 13, margin: 0, lineHeight: 1.7 }}>
                <strong style={{ color: "#22a89a" }}>⚠️ Monthly costs only.</strong> If something doesn't hit every month — car insurance paid every 6 months, annual subscriptions, holiday spending, property taxes paid in lump sums — <strong>skip it here</strong>. You'll have a dedicated section for all of those right after this one. When in doubt, skip it for now.
              </p>
            </div>
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>

              {/* HOUSING */}
              {groupHead("Housing")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Rent", "rent"], ["Mortgage Payment", "mortgage"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Property Tax (paid directly)</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Real estate taxes paid outside your mortgage — skip if already included in your mortgage payment</span>
                  <input type="number" value={form.property_tax} onChange={e => setForm(f => ({ ...f, property_tax: e.target.value }))} placeholder="$0" style={iS} />
                </div>
                {[["HOA Fees", "hoa"], ["Renters Insurance", "renters_insurance"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Housing").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Housing")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add housing item</button>
              </div>

              {/* UTILITIES */}
              {groupHead("Utilities")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Electric / Gas", "electric_gas"], ["Water / Sewer", "water"], ["Internet", "internet"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Utilities").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Utilities")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add utility</button>
              </div>

              {/* STREAMING & SUBSCRIPTIONS */}
              {groupHead("Streaming & Subscriptions")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Streaming Video</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Netflix, Amazon Video, HBO Max, Disney+, YouTube TV, Hulu, Peacock, etc. — enter your combined total</span>
                  <input type="number" value={form.streaming_video} onChange={e => setForm(f => ({ ...f, streaming_video: e.target.value }))} placeholder="$0" style={iS} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Streaming Music</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Spotify, Apple Music, Amazon Music, SiriusXM, Pandora, Tidal, etc. — combined total</span>
                  <input type="number" value={form.streaming_music} onChange={e => setForm(f => ({ ...f, streaming_music: e.target.value }))} placeholder="$0" style={iS} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Other Monthly Subscriptions</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Gaming, news, apps, software — anything paid every month</span>
                  <input type="number" value={form.other_subscriptions} onChange={e => setForm(f => ({ ...f, other_subscriptions: e.target.value }))} placeholder="$0" style={iS} />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Streaming & Subscriptions").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Service name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Streaming & Subscriptions")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add subscription</button>
              </div>

              {/* PHONE */}
              {groupHead("Phone")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Cell Phone Bill</label>
                  <input type="number" value={form.cell_phone} onChange={e => setForm(f => ({ ...f, cell_phone: e.target.value }))} placeholder="$0" style={iS} />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Phone").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Phone")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add phone item</button>
              </div>

              {/* TRANSPORTATION */}
              {groupHead("Transportation")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Car Payments</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Total of all monthly car loan or lease payments</span>
                  <input type="number" value={form.car_payment} onChange={e => setForm(f => ({ ...f, car_payment: e.target.value }))} placeholder="$0" style={iS} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Car Insurances (monthly billing only)</label>
                  <span style={{ fontSize: 11, color: "#8cb8b4", marginTop: -2 }}>Only if you pay monthly — skip and enter in Annual Expenses if you pay every 6 or 12 months</span>
                  <input type="number" value={form.car_insurance_monthly} onChange={e => setForm(f => ({ ...f, car_insurance_monthly: e.target.value }))} placeholder="$0" style={iS} />
                </div>
                {[["Gas", "gas"], ["Parking / Tolls / Transit", "parking_tolls"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Transportation").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Transportation")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add transportation item</button>
              </div>

              {/* FOOD */}
              {groupHead("Food")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Groceries", "groceries"], ["Dining Out & Takeout", "dining_out"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Food").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Food")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add food item</button>
              </div>

              {/* INSURANCE & HEALTH */}
              {groupHead("Insurance & Health")}
              <div style={{ background: "#061410", border: "1px solid #1e3a34", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                <p style={{ color: "#8cb8b4", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
                  <strong style={{ color: "#c9e8e5" }}>Only include costs that come out of your bank account.</strong> If premiums are deducted pre-tax from your paycheck, skip those — they're already out of your take-home pay and don't need to be counted here.
                </p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Health Insurance (out-of-pocket)", "health_insurance"], ["Life Insurance (monthly)", "life_insurance"], ["Dental / Vision", "dental_vision"], ["Medical Copays (avg/mo)", "medical_copays"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Insurance & Health").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Insurance & Health")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add insurance/health item</button>
              </div>

              {/* FAMILY & PERSONAL */}
              {groupHead("Family & Personal")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Childcare / Daycare", "childcare"], ["Child Support / Alimony Paid", "child_support_paid"], ["Pets", "pets"], ["Personal Care", "personal_care"], ["Gym / Fitness", "gym"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Family & Personal").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Family & Personal")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add family/personal item</button>
              </div>

              {/* SAVINGS & OTHER */}
              {groupHead("Savings & Other")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[["Savings / Investment Transfers", "savings_transfers"], ["Other Monthly", "other_monthly"]].map(([label, key]) => (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <label style={lS}>{label}</label>
                    <input type="number" value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder="$0" style={iS} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                {(form.custom_monthly_expenses || []).filter(e => e.category === "Savings & Other").map((e, ci) => {
                  const gi = form.custom_monthly_expenses.indexOf(e);
                  return (
                    <div key={ci} style={{ display: "grid", gridTemplateColumns: "1fr 140px 28px", gap: 8, marginBottom: 8 }}>
                      <input value={e.name} onChange={ev => updateCustomMonthly(gi, "name", ev.target.value)} placeholder="Item name" style={iS} />
                      <input type="number" value={e.amount} onChange={ev => updateCustomMonthly(gi, "amount", ev.target.value)} placeholder="$/mo" style={iS} />
                      <button onClick={() => removeCustomMonthly(gi)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>
                    </div>
                  );
                })}
                <button onClick={() => addCustomMonthly("Savings & Other")} style={{ ...btnS, fontSize: 11, padding: "4px 10px", marginTop: 4 }}>+ Add item</button>
              </div>

              {/* MONTHLY BUFFER — own section */}
              {groupHead("Monthly Buffer")}
              <div style={{ background: "#061410", border: "1px solid #1e3a34", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                <p style={{ color: "#8cb8b4", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
                  How much do you want to keep in reserve each month for unknowns? Small car repairs, a random copay, something that just comes up. This isn't invested or saved — it's breathing room so the plan stays on track when life happens. Many people set aside $100–$300/month depending on their situation.
                </p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Monthly Buffer / Slush Fund</label>
                  <input type="number" value={form.misc_buffer} onChange={e => setForm(f => ({ ...f, misc_buffer: e.target.value }))} placeholder="e.g. 150" style={iS} />
                </div>
              </div>

            </div>
            <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { setStep(1); setReviews(r => ({ ...r, expenses_regular: { status: "idle", messages: [], loading: false, error: null } })); }} style={{ ...btnS, fontSize: 12 }}>← Back</button>
              <button onClick={() => {
                const expData = {};
                ["rent","mortgage","property_tax","hoa","renters_insurance","electric_gas","water","internet","streaming_video","streaming_music","other_subscriptions","cell_phone","car_payment","car_insurance_monthly","gas","parking_tolls","groceries","dining_out","health_insurance","life_insurance","dental_vision","medical_copays","childcare","child_support_paid","pets","personal_care","gym","savings_transfers","misc_buffer","other_monthly"].forEach(k => { if (form[k]) expData[k] = form[k]; });
                if (form.custom_monthly_expenses?.length) expData.custom_items = form.custom_monthly_expenses.filter(e => e.name && e.amount);
                startReview("expenses_regular", REVIEW_PROMPTS.expenses_regular, expData);
              }} style={btnP}>Review with Clearpath →</button>
            </div>
            {reviews.expenses_regular.status !== "idle" && (reviews.expenses_regular.messages.length > 0 || reviews.expenses_regular.loading || reviews.expenses_regular.error) && (
              <ReviewPanel review={reviews.expenses_regular}
                onConfirm={() => confirmReview("expenses_regular")}
                onEdit={() => editSection("expenses_regular", 2)} />
            )}
          </div>
        )}

        {/* ── STEP 3: Irregular Expenses ── */}
        {step === 3 && (
          <div>
            {sectionHead("Annual & Irregular Expenses", "Things that don't hit every month — insurance, subscriptions, holidays, etc.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>
              {groupHead("Quick Add")}
              <p style={{ fontSize: 12, color: "#8cb8b4", marginBottom: 14 }}>Click to add common ones, then fill in the details.</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
                {["Car Insurance", "Home/Renters Insurance", "Amazon Prime", "Costco/Sam's Club", "Holiday Spending", "Vacation", "Car Registration", "Vet Bills", "Property Taxes", "Medical Deductible", "Dental Work"].map(name => {
                  const already = form.irregular_expenses.some(e => e.name === name);
                  return (
                    <button key={name} onClick={() => !already && setForm(f => ({ ...f, irregular_expenses: [...f.irregular_expenses, { name, mode: "spread", annual_total: "", entries: [{ month: "1", amount: "" }] }] }))}
                      style={{ ...btnS, fontSize: 11, padding: "5px 12px", opacity: already ? 0.4 : 1, cursor: already ? "default" : "pointer", border: already ? "1px solid #22a89a" : "1px solid #1e3a34", color: already ? "#22a89a" : "#8cb8b4" }}>
                      {already ? "✓ " : "+ "}{name}
                    </button>
                  );
                })}
              </div>

              {form.irregular_expenses.map((exp, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12 }}>
                    <input value={exp.name} onChange={e => updateIrregularExpense(i, "name", e.target.value)} placeholder="Expense name" style={{ ...iS, flex: 1 }} />
                    <button onClick={() => removeIrregularExpense(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20, marginTop: 2 }}>×</button>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    {[["spread", "📅 Spread evenly (÷12/mo)"], ["specific", "📆 Specific month(s)"]].map(([mode, label]) => (
                      <button key={mode} onClick={() => updateIrregularExpense(i, "mode", mode)} style={{ ...btnS, flex: 1, fontSize: 12, background: exp.mode === mode ? "#1e3a34" : "#0d2420", border: exp.mode === mode ? "1px solid #22a89a" : "1px solid #1e3a34", color: exp.mode === mode ? "#22a89a" : "#8cb8b4" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {exp.mode === "spread" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Total Annual Amount</label>
                      <input type="number" value={exp.annual_total} onChange={e => updateIrregularExpense(i, "annual_total", e.target.value)} placeholder="e.g. 1200" style={{ ...iS, maxWidth: 200 }} />
                      {exp.annual_total && <span style={{ fontSize: 11, color: "#22a89a" }}>≈ ${Math.round(parseFloat(exp.annual_total) / 12)}/mo set aside</span>}
                    </div>
                  ) : (
                    <div>
                      <label style={{ ...lS, display: "block", marginBottom: 8 }}>Month(s) and amount(s):</label>
                      {exp.entries.map((en, j) => (
                        <div key={j} style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                          <select value={en.month} onChange={e => updateIrregularEntry(i, j, "month", e.target.value)} style={{ ...iS, width: 130 }}>
                            {MONTH_NAMES.map((m, idx) => <option key={m} value={idx + 1}>{m}</option>)}
                          </select>
                          <input type="number" value={en.amount} onChange={e => updateIrregularEntry(i, j, "amount", e.target.value)} placeholder="Amount $" style={{ ...iS, flex: 1 }} />
                          {exp.entries.length > 1 && <button onClick={() => removeIrregularEntry(i, j)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18 }}>×</button>}
                        </div>
                      ))}
                      <button onClick={() => addIrregularEntry(i)} style={{ ...btnS, fontSize: 11, padding: "4px 10px" }}>+ Add month</button>
                      <div style={{ marginTop: 6, fontSize: 11, color: "#22a89a" }}>
                        Total: ${exp.entries.reduce((s, en) => s + (parseFloat(en.amount) || 0), 0).toLocaleString()}/yr
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <button onClick={addIrregularExpense} style={{ ...btnP, fontSize: 12, marginTop: 4 }}>+ Add expense</button>
            </div>
            <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { setStep(2); setReviews(r => ({ ...r, expenses_irregular: { status: "idle", messages: [], loading: false, error: null } })); }} style={{ ...btnS, fontSize: 12 }}>← Back</button>
              <button onClick={() => startReview("expenses_irregular", REVIEW_PROMPTS.expenses_irregular, { irregular_expenses: form.irregular_expenses })} style={btnP}>Review with Clearpath →</button>
            </div>
            {reviews.expenses_irregular.status !== "idle" && (reviews.expenses_irregular.messages.length > 0 || reviews.expenses_irregular.loading || reviews.expenses_irregular.error) && (
              <ReviewPanel review={reviews.expenses_irregular}
                onConfirm={() => confirmReview("expenses_irregular")}
                onEdit={() => editSection("expenses_irregular", 3)} />
            )}
          </div>
        )}

        {/* ── STEP 4: Debts ── */}
        {step === 4 && (
          <div>
            {sectionHead("Your Debts", "List every debt — estimates are totally fine.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>
              {form.debts.map((d, i) => (
                <div key={i} style={{ background: "#0a1a17", borderRadius: 10, border: "1px solid #1e3a34", padding: 16, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={{ color: "#22a89a", fontSize: 13, fontWeight: 700 }}>Debt #{i + 1}</span>
                    <button onClick={() => removeDebt(i)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20 }}>×</button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                    {[["credit_card","💳 Credit Card"],["student_loan","🎓 Student Loan"],["auto","🚗 Auto"],["mortgage","🏠 Mortgage"],["heloc","🏡 HELOC"],["personal","💼 Personal"],["medical","🏥 Medical"],["other","📋 Other"]].map(([val, label]) => (
                      <button key={val} onClick={() => updateDebt(i, "type", val)} style={{ ...btnS, fontSize: 11, padding: "4px 10px", background: d.type === val ? "#1e3a34" : "#0d2420", border: d.type === val ? "1px solid #22a89a" : "1px solid #1e3a34", color: d.type === val ? "#22a89a" : "#8cb8b4" }}>{label}</button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Name / Nickname</label>
                      <input value={d.name} onChange={e => updateDebt(i, "name", e.target.value)} placeholder={d.type === "credit_card" ? "e.g. Chase Sapphire" : "e.g. Car loan"} style={iS} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Current Balance ($)</label>
                      <input type="number" value={d.balance} onChange={e => updateDebt(i, "balance", e.target.value)} placeholder="e.g. 8500" style={iS} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Interest Rate (%)</label>
                      <input type="number" value={d.rate} onChange={e => updateDebt(i, "rate", e.target.value)} placeholder="e.g. 22.99" style={iS} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>Min Monthly Payment ($)</label>
                      <input type="number" value={d.min} onChange={e => updateDebt(i, "min", e.target.value)} placeholder="e.g. 150" style={iS} />
                    </div>
                    {d.type === "student_loan" && (
                      <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: 8 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#c9e8e5", fontSize: 13 }}>
                          <input type="checkbox" checked={d.deferred} onChange={e => updateDebt(i, "deferred", e.target.checked)} />
                          Currently deferred (not yet in repayment)
                        </label>
                        {d.deferred && (
                          <div style={{ display: "flex", gap: 10 }}>
                            <input type="number" value={d.deferred_until_month} onChange={e => updateDebt(i, "deferred_until_month", e.target.value)} placeholder="Repayment starts month (1-12)" style={{ ...iS, flex: 1 }} />
                            <input type="number" value={d.deferred_until_year} onChange={e => updateDebt(i, "deferred_until_year", e.target.value)} placeholder="Year (e.g. 2027)" style={{ ...iS, flex: 1 }} />
                          </div>
                        )}
                      </div>
                    )}
                    {d.type === "heloc" && (
                      <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: 8 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#c9e8e5", fontSize: 13 }}>
                          <input type="checkbox" checked={d.is_heloc_io} onChange={e => updateDebt(i, "is_heloc_io", e.target.checked)} />
                          Still in draw period (interest-only payments)
                        </label>
                        {d.is_heloc_io && (
                          <div style={{ display: "flex", gap: 10 }}>
                            <input type="number" value={d.heloc_draw_ends_month} onChange={e => updateDebt(i, "heloc_draw_ends_month", e.target.value)} placeholder="Draw ends month (1-12)" style={{ ...iS, flex: 1 }} />
                            <input type="number" value={d.heloc_draw_ends_year} onChange={e => updateDebt(i, "heloc_draw_ends_year", e.target.value)} placeholder="Year (e.g. 2027)" style={{ ...iS, flex: 1 }} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button onClick={addDebt} style={btnP}>+ Add a debt</button>
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
            <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { setStep(3); setReviews(r => ({ ...r, debts: { status: "idle", messages: [], loading: false, error: null } })); }} style={{ ...btnS, fontSize: 12 }}>← Back</button>
              <button onClick={() => {
                if (!form.debts.length) { alert("Please add at least one debt."); return; }
                startReview("debts", REVIEW_PROMPTS.debts, { debts: form.debts });
              }} style={btnP}>Review with Clearpath →</button>
            </div>
            {reviews.debts.status !== "idle" && (reviews.debts.messages.length > 0 || reviews.debts.loading || reviews.debts.error) && (
              <ReviewPanel review={reviews.debts}
                onConfirm={() => confirmReview("debts")}
                onEdit={() => editSection("debts", 4)} />
            )}
          </div>
        )}

        {/* ── STEP 5: Goals ── */}
        {step === 5 && (
          <div>
            {sectionHead("Goals & Commitment", "Almost there! Just a few final questions.")}
            <div style={{ background: "#0d2420", borderRadius: 12, border: "1px solid #1e3a34", padding: 24 }}>
              {groupHead("Priority")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
                {[["speed","🏁 Speed","Get debt free ASAP"],["save_interest","💰 Save Money","Pay least total interest"],["cash_flow","📆 Free Cash Flow","Lower bills quickly"],["balanced","⚖️ Balanced","Reasonable middle ground"]].map(([val, label, sub]) => (
                  <button key={val} onClick={() => setForm(f => ({ ...f, priority: val }))} style={{ ...btnS, padding: "12px 14px", textAlign: "left", background: form.priority === val ? "#1e3a34" : "#0d2420", border: form.priority === val ? "1px solid #22a89a" : "1px solid #1e3a34" }}>
                    <div style={{ color: form.priority === val ? "#22a89a" : "#e8f5f3", fontWeight: 700, fontSize: 13 }}>{label}</div>
                    <div style={{ color: "#8cb8b4", fontSize: 11, marginTop: 2 }}>{sub}</div>
                  </button>
                ))}
              </div>

              {groupHead("Emergency Fund")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Current Emergency Fund ($)</label>
                  <input type="number" value={form.emergency_fund_current} onChange={e => setForm(f => ({ ...f, emergency_fund_current: e.target.value }))} placeholder="0" style={iS} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Target Emergency Fund ($)</label>
                  <input type="number" value={form.emergency_fund_target} onChange={e => setForm(f => ({ ...f, emergency_fund_target: e.target.value }))} placeholder="e.g. 15000" style={iS} />
                </div>
              </div>

              {groupHead("Other Preferences")}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={form.open_to_refi} onChange={e => setForm(f => ({ ...f, open_to_refi: e.target.checked }))} />
                  <span style={{ color: "#c9e8e5", fontSize: 13 }}>I'm open to refinancing if it would save meaningful money</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Any debt you really want gone first?</label>
                  <input value={form.emotional_priority} onChange={e => setForm(f => ({ ...f, emotional_priority: e.target.value }))} placeholder="e.g. 'Get rid of my Amex — I hate it'" style={iS} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={lS}>Any big upcoming expenses?</label>
                  <input value={form.upcoming_expenses} onChange={e => setForm(f => ({ ...f, upcoming_expenses: e.target.value }))} placeholder="e.g. Wedding in 2026, ~$15k" style={iS} />
                </div>
              </div>

              {groupHead("Monthly Commitment")}
              {(() => {
                const p = buildPayload();
                const trueSurplus = p.surplus - p.total_minimums;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ background: "#061410", borderRadius: 8, border: "1px solid #1e3a34", padding: "12px 16px", marginBottom: 14 }}>
                      {[["Monthly take-home", `$${p.income.monthly_takehome.toLocaleString()}`, "#22a89a"],["Monthly expenses (incl. annual ÷12)", `-$${p.expenses.total_monthly.toLocaleString()}`, "#f87171"],["Debt minimums", `-$${p.total_minimums.toLocaleString()}`, "#f87171"]].map(([label, val, color]) => (
                        <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                          <span style={{ color: "#8cb8b4" }}>{label}</span>
                          <span style={{ color, fontWeight: 700 }}>{val}</span>
                        </div>
                      ))}
                      <div style={{ borderTop: "1px solid #1e3a34", paddingTop: 8, marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                        <span style={{ color: "#e8c87a", fontWeight: 700 }}>True monthly surplus:</span>
                        <span style={{ color: trueSurplus >= 0 ? "#22a89a" : "#f87171", fontWeight: 800 }}>${trueSurplus.toLocaleString()}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={lS}>How much do you want to commit to debt payoff each month?</label>
                      <input type="number" value={form.monthly_committed} onChange={e => setForm(f => ({ ...f, monthly_committed: e.target.value }))} placeholder="Enter amount" style={iS} />
                      <p style={{ fontSize: 11, color: "#8cb8b4", margin: 0, lineHeight: 1.6 }}>Keeping a buffer is smart — a plan that's too aggressive gets abandoned. Many people commit 80–90% of their surplus.</p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { setStep(4); setReviews(r => ({ ...r, goals: { status: "idle", messages: [], loading: false, error: null } })); }} style={{ ...btnS, fontSize: 12 }}>← Back</button>
              <button onClick={() => {
                if (!form.monthly_committed) { alert("Please enter your monthly commitment amount."); return; }
                startReview("goals", REVIEW_PROMPTS.goals, buildPayload());
              }} style={btnP}>Review with Clearpath →</button>
            </div>
            {reviews.goals.status !== "idle" && (reviews.goals.messages.length > 0 || reviews.goals.loading || reviews.goals.error) && (
              <ReviewPanel review={reviews.goals}
                onConfirm={generatePlan}
                onEdit={() => editSection("goals", 5)} />
            )}
            {planError && <p style={{ color: "#f87171", fontSize: 13, marginTop: 12 }}>{planError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

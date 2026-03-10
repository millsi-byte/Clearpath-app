import { useState, useRef, useEffect } from "react";


const MODELS = "claude-sonnet-4-20250514";

function parseMarkdown(text) {
  // Bold
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code style="background:#1e3a5f;padding:2px 6px;border-radius:3px;font-size:0.9em;">$1</code>');
  // Headers
  text = text.replace(/^### (.*$)/gm, '<h3 style="color:#7eb8f7;font-size:1em;font-weight:700;margin:12px 0 4px;">$1</h3>');
  text = text.replace(/^## (.*$)/gm, '<h2 style="color:#7eb8f7;font-size:1.1em;font-weight:700;margin:14px 0 6px;">$1</h2>');
  // Horizontal rules
  text = text.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #1e3a5f;margin:12px 0;"/>');
  // Tables
  text = text.replace(/\|(.+)\|/g, (match) => {
    const cells = match.split('|').filter(c => c.trim());
    const isHeader = false;
    return '<tr>' + cells.map(c => `<td style="padding:5px 10px;border:1px solid #1e3a5f;">${c.trim()}</td>`).join('') + '</tr>';
  });
  // Bullet lists
  text = text.replace(/^[\-\*] (.+)$/gm, '<li style="margin:3px 0 3px 16px;">$1</li>');
  text = text.replace(/(<li.*<\/li>\n?)+/g, m => `<ul style="margin:6px 0;padding:0;">${m}</ul>`);
  // Numbered lists
  text = text.replace(/^\d+\. (.+)$/gm, '<li style="margin:3px 0 3px 16px;">$1</li>');
  // Line breaks
  text = text.replace(/\n/g, '<br/>');
  // Tables: wrap consecutive tr rows
  text = text.replace(/(<tr>.*?<\/tr><br\/>)+/g, m => 
    `<table style="border-collapse:collapse;margin:8px 0;font-size:0.85em;width:100%;">${m.replace(/<br\/>/g,'')}</table>`
  );
  return text;
}

export default function DebtPlannerApp() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [planData, setPlanData] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const conversationRef = useRef([]);
  const [systemPrompt, setSystemPrompt] = useState("");

  useEffect(() => {
    fetch("/system-prompt.txt")
      .then(r => r.text())
      .then(text => setSystemPrompt(text))
      .catch(err => console.error("Failed to load system prompt:", err));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const extractPlanData = (text) => {
    // Try tagged version first
    const match = text.match(/<plan_data>([\s\S]*?)<\/plan_data>/);
    if (match) {
      try { return JSON.parse(match[1].trim()); }
      catch(e) { console.error("Failed to parse plan_data (tagged):", e); }
    }
    // Fallback: look for raw JSON block with meta + debts keys
    const jsonMatch = text.match(/\{[\s\S]*"meta"[\s\S]*"debts"[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); }
      catch(e) { console.error("Failed to parse plan_data (untagged):", e); }
    }
    return null;
  };

  const stripPlanData = (text) => {
    // Remove tagged block
    let stripped = text.replace(/<plan_data>[\s\S]*?<\/plan_data>/, "").trim();
    // Also remove raw JSON block if it was detected (starts with { contains "meta")
    stripped = stripped.replace(/\{[\s\S]*"meta"[\s\S]*"debts"[\s\S]*\}/, "").trim();
    return stripped;
  };

  const callClaude = async (userMessage) => {
    setLoading(true);
    setError(null);

    const newUserMsg = { role: "user", content: userMessage };
    conversationRef.current = [...conversationRef.current, newUserMsg];

    setMessages(prev => [...prev, { role: "user", text: userMessage }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: systemPrompt,
          messages: conversationRef.current,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err?.error?.message || "API error");
      }

      const data = await response.json();
      const rawText = data.content?.[0]?.text || "";

      const extracted = extractPlanData(rawText);
      const displayText = extracted ? stripPlanData(rawText) : rawText;

      const assistantMsg = { role: "assistant", content: rawText };
      conversationRef.current = [...conversationRef.current, assistantMsg];

      setMessages(prev => [...prev, { role: "assistant", text: displayText }]);

      if (extracted) {
        setPlanData(extracted);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };


  const TEST_PLAN_DATA = {"meta":{"name":"Scott","generated":"March 2026","strategy":"HELOC-First Hybrid","start_month":3,"start_year":2026},"income":{"monthly_takehome":13500,"gross_annual_salary":320000,"income_changes":[{"month":9,"year":2026,"delta":540,"note":"8% raise"},{"month":1,"year":2027,"delta":135,"note":"3% annual raise for spouse"}]},"expenses":{"regular":[{"name":"Mortgage","amount":3000,"category":"Housing"},{"name":"Electric","amount":250,"category":"Utilities"},{"name":"Internet","amount":90,"category":"Utilities"},{"name":"Cell phone","amount":245,"category":"Phone"},{"name":"Gas","amount":240,"category":"Transportation"},{"name":"Groceries","amount":1600,"category":"Food"},{"name":"Dining out","amount":1600,"category":"Food"},{"name":"Gym","amount":30,"category":"Personal"},{"name":"Buffer","amount":300,"category":"Miscellaneous"}],"irregular":[{"name":"Car insurance","amount":1400,"mode":"specific_months","months":[1,7]},{"name":"Vacation","amount":12000,"mode":"spread","months":[1,2,3,4,5,6,7,8,9,10,11,12]},{"name":"Holiday spending","amount":4000,"mode":"specific_months","months":[11,12]},{"name":"Heating oil","amount":2500,"mode":"specific_months","months":[9,10,11,12,1,2]},{"name":"Lawn care","amount":1000,"mode":"specific_months","months":[5,6,7,8,9]}]},"debts":[{"name":"HELOC","balance":88000,"rate":0.0625,"min":450,"type":"heloc","is_heloc_io":true,"heloc_draw_ends":{"month":1,"year":2031},"deferred_until":null},{"name":"Hayley Loan","balance":20000,"rate":0.0824,"min":0,"type":"student_loan","is_heloc_io":false,"heloc_draw_ends":null,"deferred_until":{"month":12,"year":2029}},{"name":"Car Loan","balance":30000,"rate":0.05,"min":566,"type":"auto","is_heloc_io":false,"heloc_draw_ends":null,"deferred_until":{"month":5,"year":2026}},{"name":"Corey Loan","balance":19000,"rate":0.0459,"min":0,"type":"student_loan","is_heloc_io":false,"heloc_draw_ends":null,"deferred_until":{"month":12,"year":2026}},{"name":"Mortgage","balance":240000,"rate":0.0252,"min":3000,"type":"mortgage","is_heloc_io":false,"heloc_draw_ends":null,"deferred_until":null}],"attack_order":["HELOC","Hayley Loan","Car Loan","Corey Loan","Mortgage"],"monthly_committed":3450,"windfalls":[{"name":"Bonus","amount":25500,"month":9,"year":2026},{"name":"Stock vesting","amount":2000,"month":2,"year":2026},{"name":"Stock vesting","amount":2000,"month":5,"year":2026},{"name":"Stock vesting","amount":2000,"month":8,"year":2026},{"name":"Stock vesting","amount":2000,"month":11,"year":2026}],"goals":{"priority":"speed","emergency_fund_current":0,"emergency_fund_target":30000,"open_to_refi":true,"notes":"HELOC draw ends Jan 2031. Car loan starts May 2026. Deferred student loans."}};

  const handleLoadTest = () => {
    setPlanData(TEST_PLAN_DATA);
    setStarted(true);
    setMessages([
      { role: "assistant", text: "✅ **Test data loaded** — Scott's complete plan is ready. Click the **Download Plan** button to test the Excel generator." }
    ]);
  };

  const handleStart = () => {
    setStarted(true);
    callClaude("Hello, I\'m ready to build my debt payoff plan.");
  };

  const handleSend = () => {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput("");
    callClaude(msg);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDownload = async () => {
    if (!planData) return;
    setIsDownloading(true);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planData),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to generate plan");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${planData?.meta?.name || "DebtPlan"}_DebtPayoffPlan.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download error:", err);
      alert("Could not generate your plan: " + err.message);
    } finally {
      setIsDownloading(false);
    }
  };

  // ── LANDING SCREEN ──────────────────────────────────────────
  if (!started) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(160deg, #0a1628 0%, #0d2040 50%, #0a1628 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Georgia', serif",
        padding: "20px",
      }}>
        <div style={{ maxWidth: 560, width: "100%", textAlign: "center" }}>
          {/* Logo mark */}
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "linear-gradient(135deg, #1a4a8a, #2d7dd2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 28px",
            boxShadow: "0 0 40px rgba(45,125,210,0.3)",
          }}>
            <span style={{ fontSize: 28 }}>📊</span>
          </div>

          <h1 style={{
            color: "#ffffff",
            fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            margin: "0 0 12px",
            lineHeight: 1.2,
          }}>
            Clearpath
          </h1>

          <p style={{
            color: "#7eb8f7",
            fontSize: "clamp(0.95rem, 2.2vw, 1.15rem)",
            fontWeight: 400,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            margin: "0 0 10px",
            fontStyle: "normal",
          }}>
            AI Debt Payoff Planner
          </p>

          <p style={{
            color: "#4a7aaa",
            fontSize: "0.9rem",
            margin: "0 0 36px",
            lineHeight: 1.6,
            fontStyle: "italic",
          }}>
            Your personalized path to debt freedom.
          </p>

          <div style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: "24px 28px",
            marginBottom: 32,
            textAlign: "left",
          }}>
            {[
              ["💬", "Conversational interview", "Talk through your numbers naturally — no spreadsheet needed"],
              ["🧮", "Three plan options", "Avalanche, Snowball, and a custom hybrid — with real interest savings"],
              ["📥", "Personalized Excel file", "Download a complete plan with your strategy, milestones, and projections"],
            ].map(([icon, title, desc]) => (
              <div key={title} style={{ display: "flex", gap: 14, marginBottom: 18, alignItems: "flex-start" }}>
                <span style={{ fontSize: 20, lineHeight: 1.4 }}>{icon}</span>
                <div>
                  <div style={{ color: "#ffffff", fontWeight: 600, fontSize: "0.95rem", marginBottom: 3 }}>{title}</div>
                  <div style={{ color: "#8ba5c4", fontSize: "0.85rem", lineHeight: 1.5 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={handleStart}
            style={{
              background: "linear-gradient(135deg, #1a5fa8, #2d7dd2)",
              color: "#ffffff",
              border: "none",
              borderRadius: 12,
              padding: "16px 40px",
              fontSize: "1rem",
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "0.02em",
              boxShadow: "0 4px 24px rgba(45,125,210,0.4)",
              transition: "all 0.2s",
              width: "100%",
            }}
            onMouseEnter={e => e.target.style.transform = "translateY(-2px)"}
            onMouseLeave={e => e.target.style.transform = "translateY(0)"}
          >
            Build My Plan →
          </button>

          <button
            onClick={handleLoadTest}
            style={{
              background: "transparent",
              color: "#4a6a8a",
              border: "1px dashed #4a6a8a",
              borderRadius: 12,
              padding: "10px 24px",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
              marginTop: 12,
              width: "100%",
            }}
          >
            🧪 Load Test Data (skip interview)
          </button>

          <p style={{ color: "#4a6a8a", fontSize: "0.78rem", marginTop: 16 }}>
            Takes 20–30 minutes · Have account balances and details handy if possible
          </p>
        </div>
      </div>
    );
  }

  // ── CHAT SCREEN ─────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a1628",
      display: "flex",
      flexDirection: "column",
      fontFamily: "'Georgia', serif",
    }}>
      {/* Header */}
      <div style={{
        background: "rgba(10,22,40,0.95)",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        padding: "14px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        position: "sticky",
        top: 0,
        zIndex: 10,
        backdropFilter: "blur(10px)",
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%",
          background: "linear-gradient(135deg, #1a4a8a, #2d7dd2)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, flexShrink: 0,
        }}>📊</div>
        <div>
          <div style={{ color: "#ffffff", fontWeight: 700, fontSize: "0.95rem" }}>Clearpath — AI Debt Payoff Planner</div>
          <div style={{ color: "#4a7aaa", fontSize: "0.75rem" }}>
            {loading ? "Thinking..." : planData ? "✅ Plan ready" : "Interview in progress"}
          </div>
        </div>
        {planData && (
          <button
            onClick={handleDownload}
              disabled={isDownloading}
            style={{
              marginLeft: "auto",
              background: "linear-gradient(135deg, #1a7a4a, #22a060)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "8px 18px",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 2px 12px rgba(34,160,96,0.4)",
            }}
          >
            ⬇ Download Plan
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "20px 16px",
        maxWidth: 760,
        width: "100%",
        margin: "0 auto",
        boxSizing: "border-box",
      }}>
        {messages.map((msg, i) => (
          <div key={i} style={{
            display: "flex",
            justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            marginBottom: 16,
            gap: 10,
            alignItems: "flex-start",
          }}>
            {msg.role === "assistant" && (
              <div style={{
                width: 30, height: 30, borderRadius: "50%",
                background: "linear-gradient(135deg, #1a4a8a, #2d7dd2)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, flexShrink: 0, marginTop: 4,
              }}>📊</div>
            )}
            <div style={{
              maxWidth: "80%",
              background: msg.role === "user"
                ? "linear-gradient(135deg, #1a5fa8, #2d7dd2)"
                : "rgba(255,255,255,0.05)",
              border: msg.role === "user" ? "none" : "1px solid rgba(255,255,255,0.08)",
              borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "4px 18px 18px 18px",
              padding: "12px 16px",
              color: "#e8f0ff",
              fontSize: "0.9rem",
              lineHeight: 1.6,
            }}>
              {msg.role === "assistant"
                ? <div dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }} />
                : msg.text
              }
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{
              width: 30, height: 30, borderRadius: "50%",
              background: "linear-gradient(135deg, #1a4a8a, #2d7dd2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, flexShrink: 0,
            }}>📊</div>
            <div style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "4px 18px 18px 18px",
              padding: "14px 18px",
              display: "flex", gap: 6, alignItems: "center",
            }}>
              {[0,1,2].map(i => (
                <div key={i} style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: "#2d7dd2",
                  animation: "pulse 1.2s ease-in-out infinite",
                  animationDelay: `${i * 0.2}s`,
                }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: "rgba(200,50,50,0.15)",
            border: "1px solid rgba(200,50,50,0.3)",
            borderRadius: 10,
            padding: "12px 16px",
            color: "#ff8080",
            fontSize: "0.85rem",
            marginBottom: 16,
          }}>
            ⚠ {error}
          </div>
        )}

        {planData && (
          <div style={{
            background: "rgba(34,160,96,0.1)",
            border: "1px solid rgba(34,160,96,0.3)",
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 16,
            textAlign: "center",
          }}>
            <div style={{ color: "#5ddb9a", fontWeight: 700, fontSize: "1rem", marginBottom: 6 }}>
              🎉 Your plan is ready!
            </div>
            <div style={{ color: "#8ba5c4", fontSize: "0.85rem", marginBottom: 14 }}>
              Strategy: <strong style={{ color: "#ffffff" }}>{planData.meta?.strategy}</strong>
              &nbsp;·&nbsp; Prepared for: <strong style={{ color: "#ffffff" }}>{planData.meta?.name}</strong>
            </div>
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              style={{
                background: "linear-gradient(135deg, #1a7a4a, #22a060)",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "12px 28px",
                fontSize: "0.95rem",
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 2px 16px rgba(34,160,96,0.4)",
              }}
            >
              {isDownloading ? "⏳ Generating..." : "⬇ Download Your Excel Plan"}
            </button>
            <div style={{ color: "#4a7a5a", fontSize: "0.75rem", marginTop: 8 }}>
              This data will be used to generate your Excel file
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        borderTop: "1px solid rgba(255,255,255,0.07)",
        background: "rgba(10,22,40,0.98)",
        padding: "14px 16px",
        position: "sticky",
        bottom: 0,
      }}>
        <div style={{
          maxWidth: 760,
          margin: "0 auto",
          display: "flex",
          gap: 10,
          alignItems: "flex-end",
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Waiting for response..." : "Type your answer here..."}
            disabled={loading}
            rows={1}
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 12,
              padding: "12px 16px",
              color: "#e8f0ff",
              fontSize: "0.9rem",
              resize: "none",
              fontFamily: "inherit",
              lineHeight: 1.5,
              outline: "none",
              minHeight: 46,
              maxHeight: 140,
              overflowY: "auto",
            }}
            onInput={e => {
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            style={{
              background: loading || !input.trim()
                ? "rgba(255,255,255,0.08)"
                : "linear-gradient(135deg, #1a5fa8, #2d7dd2)",
              color: loading || !input.trim() ? "#4a6a8a" : "#ffffff",
              border: "none",
              borderRadius: 12,
              width: 46,
              height: 46,
              fontSize: "1.2rem",
              cursor: loading || !input.trim() ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "all 0.2s",
            }}
          >
            ↑
          </button>
        </div>
        <div style={{
          maxWidth: 760,
          margin: "8px auto 0",
          color: "#2a4a6a",
          fontSize: "0.72rem",
          textAlign: "center",
        }}>
          Press Enter to send · Shift+Enter for new line
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
      `}</style>
    </div>
  );
}

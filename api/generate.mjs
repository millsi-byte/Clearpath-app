// generate.mjs — Clearpath Excel generator using xlsx (SheetJS)
// SheetJS works in Vercel serverless with no native dependencies

import pkg from 'xlsx';
const { utils, write } = pkg;

const MN=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const r2=(n)=>Math.round(n*100)/100;

// ── SIMULATION ────────────────────────────────────────────────────────────────
function simulate(data){
  const{income,expenses,debts,attack_order,monthly_committed,windfalls=[],meta}=data;
  const ds=debts.map(d=>({...d}));

  const irregLkp={};
  for(const ie of(expenses.irregular||[])){
    const months=ie.mode==='spread'?[1,2,3,4,5,6,7,8,9,10,11,12]:(ie.months||[]);
    for(const m of months){
      const amt=ie.mode==='spread'?ie.amount/12:ie.amount;
      if(!irregLkp[m])irregLkp[m]=[];
      irregLkp[m].push({name:ie.name,amount:amt});
    }
  }

  const wfLkp={};
  for(const w of windfalls){
    const k=`${w.year}-${w.month}`;
    if(!wfLkp[k])wfLkp[k]=[];
    wfLkp[k].push({name:w.name,amount:w.amount});
  }

  const icSorted=(income.income_changes||[]).slice().sort((a,b)=>a.year!==b.year?a.year-b.year:a.month-b.month);
  let incDelta=0;
  const plan=[];
  let yr=meta.start_year,mo=meta.start_month;

  for(let iter=0;iter<360;iter++){
    for(const ic of icSorted)if(ic.year===yr&&ic.month===mo)incDelta+=ic.delta;
    const baseIncome=income.monthly_takehome+incDelta;
    const regItems=(expenses.regular||[]).filter(e=>e.amount>0);
    const regTotal=regItems.reduce((s,e)=>s+e.amount,0);
    const irregItems=irregLkp[mo]||[];
    const irregTotal=irregItems.reduce((s,i)=>s+i.amount,0);
    const wfItems=wfLkp[`${yr}-${mo}`]||[];
    const wfTotal=wfItems.reduce((s,w)=>s+w.amount,0);
    const totalExp=regTotal+irregTotal;
    const totalIncome=baseIncome+wfTotal;
    const surplus=totalIncome-totalExp;
    const committed=monthly_committed+wfTotal;
    const totalMins=ds.filter(d=>d.balance>0).reduce((s,d)=>s+d.min,0);
    const extra=Math.max(0,committed-totalMins);

    const dc={};
    for(const d of ds){
      if(d.balance<=0){dc[d.name]={interest:0,minPmt:0,minPrin:0};continue;}
      const interest=r2(d.balance*(d.rate/12));
      const minPmt=Math.min(d.min,d.balance+interest);
      const minPrin=Math.max(0,minPmt-interest);
      dc[d.name]={interest,minPmt,minPrin};
    }

    let remExtra=extra;
    const alloc={};for(const d of ds)alloc[d.name]=0;
    for(const tgt of attack_order){
      if(remExtra<=0)break;
      const d=ds.find(x=>x.name===tgt);
      if(!d||d.balance<=0)continue;
      const cap=Math.max(0,r2(d.balance-dc[tgt].minPrin));
      const app=r2(Math.min(remExtra,cap));
      alloc[tgt]=app;remExtra=r2(remExtra-app);
    }

    const target=attack_order.find(n=>{const d=ds.find(x=>x.name===n);return d&&d.balance>0;})||null;
    const detail=[];
    for(const d of ds){
      if(d.balance<=0){detail.push({name:d.name,begBal:0,min:d.min,interest:0,minPrincipal:0,extraPrincipal:0,totalPaid:0,endBal:0,isTarget:false,paidOffNow:false});continue;}
      const beg=d.balance;
      const{interest,minPmt,minPrin}=dc[d.name];
      const ep=alloc[d.name];
      const totalPaid=minPmt+ep;
      const end=Math.max(0,r2(beg-minPrin-ep));
      const paidOffNow=end===0&&beg>0;
      d.balance=end;
      detail.push({name:d.name,begBal:beg,min:d.min,interest,minPrincipal:minPrin,extraPrincipal:ep,totalPaid,endBal:end,isTarget:ep>0,paidOffNow});
    }
    const totalDebt=ds.reduce((s,d)=>s+d.balance,0);
    plan.push({year:yr,month:mo,label:`${MN[mo]} ${yr}`,income:baseIncome,regItems,regTotal,irregItems,irregTotal,wfItems,wfTotal,totalIncomeThisMonth:totalIncome,totalExpenses:totalExp,surplus,totalMinimums:totalMins,extraToTarget:extra,target,detail,totalDebt});
    if(totalDebt<=0)break;
    mo++;if(mo>12){mo=1;yr++;}
  }
  return plan;
}

function buildYOY(plan,data){
  const{debts,attack_order,income}=data;
  const ym={};
  for(const m of plan){
    if(!ym[m.year])ym[m.year]={year:m.year,months:[],payoffs:[],windfalls:[]};
    ym[m.year].months.push(m);
    for(const dd of m.detail)if(dd.paidOffNow)ym[m.year].payoffs.push([m.label,dd.name]);
    for(const w of m.wfItems)ym[m.year].windfalls.push([m.label,w.name,w.amount]);
  }
  return Object.values(ym).sort((a,b)=>a.year-b.year).map(yd=>{
    const{months}=yd;
    const debtRows=debts.map(debt=>{
      const dn=debt.name;
      const begBal=months.reduce((f,m)=>{if(f>0)return f;const dd=m.detail.find(d=>d.name===dn);return dd&&dd.begBal>0?dd.begBal:0;},0);
      const last=months[months.length-1];
      const lastD=last.detail.find(d=>d.name===dn);
      const endBal=lastD?lastD.endBal:0;
      const sum=(fn)=>months.reduce((s,m)=>{const dd=m.detail.find(d=>d.name===dn);return s+(dd?fn(dd):0);},0);
      const payoffMo=yd.payoffs.find(([,n])=>n===dn)?.[0]||null;
      return{name:dn,begBal,minPerMo:debt.min,interest:sum(d=>d.interest),minPrincipal:sum(d=>d.minPrincipal),extraPrincipal:sum(d=>d.extraPrincipal),totalPaid:sum(d=>d.totalPaid),endBal,isTarget:months.some(m=>m.target===dn),payoffMonth:payoffMo};
    });
    const yi=debtRows.reduce((s,r)=>s+r.interest,0);
    const ym2=debtRows.reduce((s,r)=>s+r.minPrincipal,0);
    const ye=debtRows.reduce((s,r)=>s+r.extraPrincipal,0);
    const yp=debtRows.reduce((s,r)=>s+r.totalPaid,0);
    const bt=debtRows.reduce((s,r)=>s+r.begBal,0);
    const et=debtRows.reduce((s,r)=>s+r.endBal,0);
    const bullets=[];
    for(const[wMo,wn,wa]of yd.windfalls)bullets.push(`${wMo}: ${wn} ($${Math.round(wa).toLocaleString()}) applied as lump sum to target debt.`);
    for(const[pMo,dn]of yd.payoffs){
      const idx=attack_order.indexOf(dn);
      const nxt=idx>=0&&idx+1<attack_order.length?attack_order[idx+1]:null;
      const freed=debts.find(d=>d.name===dn)?.min||0;
      bullets.push(`${dn} PAID OFF — ${pMo}.${nxt?` $${freed.toLocaleString()}/mo cascades to ${nxt}.`:' YOU ARE DEBT FREE!'}`);
    }
    for(const ic of(income.income_changes||[]).filter(ic=>ic.year===yd.year))
      bullets.push(`${MN[ic.month]} ${yd.year}: ${ic.note} — surplus +$${ic.delta.toLocaleString()}/mo.`);
    if(!bullets.length){const tgt=debtRows.find(r=>r.isTarget);if(tgt)bullets.push(`Full surplus directed to ${tgt.name} all year.`);}
    return{year:yd.year,debtRows,yi,ym:ym2,ye,yp,bt,et,bullets};
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmt$(n){if(n===null||n===undefined||n==='')return '';return `$${Math.round(n).toLocaleString()}`;}
function fmtPct(n){return n?`${(n*100).toFixed(2)}%`:'';}

// SheetJS workbook builder — plain data, no fancy styling (SheetJS free tier)
function buildWorkbook(data,plan,yoy,debtFree){
  const wb=utils.book_new();

  // ── START HERE ──
  const sh=[];
  sh.push(['DEBT PAYOFF PLANNER — AI-Generated Plan']);
  sh.push([`For: ${data.meta.name}   |   Generated: ${data.meta.generated}   |   Strategy: ${data.meta.strategy}   |   Debt-Free Target: ${debtFree}`]);
  sh.push([]);
  sh.push(['WHAT IS THIS FILE?']);
  sh.push(['This spreadsheet is your complete, personalized debt payoff plan — built specifically for you based on your income, expenses, and debts, calculated month by month until you are completely debt free.']);
  sh.push([]);
  sh.push(["WHAT'S IN EACH TAB"]);
  sh.push(['Tab','What It Shows','When To Use It']);
  sh.push(['START HERE','Overview, instructions, and disclaimers','Once at the start. Return anytime you have questions.']);
  sh.push(['My Plan','Strategy summary, attack order, milestone dates','Read first. Refer back for the big picture.']);
  sh.push(['Month-by-Month','First 24 months: expenses, payments, balances','Every month — your primary action tab.']);
  sh.push(['Year-by-Year','Full timeline to debt freedom','Review annually against actual progress.']);
  sh.push([]);
  sh.push(['HOW TO USE THIS PLAN']);
  sh.push(['Step 1','Read My Plan tab. Note your attack order and milestone dates.']);
  sh.push(['Step 2 (MOST IMPORTANT)','Open Month-by-Month each month. Pay the exact amounts shown under PAYMENTS THIS MONTH.']);
  sh.push(['Step 3','Apply any windfalls (tax refund, bonus) directly to your current target debt immediately.']);
  sh.push(['Step 4','Review Year-by-Year annually against your actual progress.']);
  sh.push(['Step 5','Re-run the AI interview if income/expenses/debts change significantly.']);
  sh.push([]);
  sh.push(['IMPORTANT DISCLAIMERS']);
  sh.push(['NOT FINANCIAL ADVICE — This plan is a calculation tool, not professional financial advice. Generated by AI based on information you provided.']);
  sh.push(['ACCURACY — Plan quality depends on the accuracy of information provided. Estimated numbers will cause projected dates to differ from reality.']);
  sh.push(['VARIABLE RATES — Variable rate loans (e.g., HELOC) may change. Plan uses rates at time of generation.']);
  sh.push(['CONSULT A PROFESSIONAL — For complex situations (taxes, bankruptcy, retirement) consult a licensed financial advisor.']);
  const wsStart=utils.aoa_to_sheet(sh);
  wsStart['!cols']=[{wch:18},{wch:55},{wch:40}];
  utils.book_append_sheet(wb,wsStart,'START HERE');

  // ── MY PLAN ──
  const mp=[];
  mp.push([`DEBT PAYOFF PLAN — ${data.meta.name.toUpperCase()}`]);
  mp.push([`Strategy: ${data.meta.strategy}   |   Generated: ${data.meta.generated}   |   Debt-Free Target: ${debtFree}`]);
  mp.push([]);
  mp.push(['FINANCIAL SNAPSHOT']);
  const regTotal=(data.expenses.regular||[]).reduce((s,e)=>s+e.amount,0);
  const irregAnnual=(data.expenses.irregular||[]).reduce((s,ie)=>s+ie.amount*((ie.mode==='spread'?12:(ie.months||[]).length)),0)/12;
  mp.push(['Monthly Take-Home Income',fmt$(data.income.monthly_takehome)]);
  mp.push(['Monthly Regular Expenses',fmt$(regTotal)]);
  mp.push(['Monthly Avg — Irregular/Seasonal',fmt$(irregAnnual)]);
  mp.push(['Average True Monthly Surplus',fmt$(data.income.monthly_takehome-regTotal-irregAnnual)]);
  mp.push(['Emergency Fund (Current / Target)',`${fmt$(data.goals?.emergency_fund_current||0)}  /  ${fmt$(data.goals?.emergency_fund_target||0)}`]);
  mp.push([]);
  mp.push([`DEBT ATTACK ORDER (${data.meta.strategy})`]);
  mp.push(['Priority','Debt Name','Current Balance','Interest Rate','Min Payment/Mo']);
  data.attack_order.forEach((ao,i)=>{
    const debt=data.debts.find(d=>d.name===ao);if(!debt)return;
    mp.push([`#${i+1}${i===0?' ← ATTACKING NOW':''}`,debt.name,fmt$(debt.balance),fmtPct(debt.rate),fmt$(debt.min)]);
  });
  mp.push(['TOTAL','',fmt$(data.debts.reduce((s,d)=>s+d.balance,0)),'',fmt$(data.debts.reduce((s,d)=>s+d.min,0))]);
  mp.push([]);
  mp.push(['KEY MILESTONES']);
  mp.push(['When','Milestone','Notes']);
  for(const m of plan){
    for(const dd of m.detail){
      if(!dd.paidOffNow)continue;
      const idx=data.attack_order.indexOf(dd.name);
      const nxt=idx>=0&&idx+1<data.attack_order.length?data.attack_order[idx+1]:null;
      const freed=data.debts.find(d=>d.name===dd.name)?.min||0;
      mp.push([m.label,`${dd.name} PAID OFF`,nxt?`$${freed.toLocaleString()}/mo cascades to ${nxt}`:'YOU ARE DEBT FREE! 🎉']);
    }
  }
  mp.push([]);
  mp.push(['YOUR STRATEGY IN PLAIN ENGLISH']);
  const fTarget=data.attack_order[0];const fDebt=data.debts.find(d=>d.name===fTarget);
  mp.push([`You are using the ${data.meta.strategy.toUpperCase()} method. Every dollar of surplus above minimum payments goes to ${fTarget} (${fDebt?(fDebt.rate*100).toFixed(2)+'%':''}) until eliminated. When paid off, that freed payment cascades to the next debt. Stay consistent and you will reach debt freedom by ${debtFree}.`]);
  const wsMp=utils.aoa_to_sheet(mp);
  wsMp['!cols']=[{wch:22},{wch:32},{wch:16},{wch:14},{wch:16}];
  utils.book_append_sheet(wb,wsMp,'My Plan');

  // ── MONTH-BY-MONTH ──
  const N=Math.min(24,plan.length);
  const mbm=[];
  mbm.push(['MONTH-BY-MONTH DETAIL — FIRST 24 MONTHS']);
  mbm.push(['Full income · expense line items · debt payments · balances for every month']);
  mbm.push([]);

  // Header row
  const hdr1=['Category / Item'];
  const hdr2=[''];
  for(let i=0;i<N;i++){hdr1.push(String(plan[i].year));hdr2.push(MN[plan[i].month]);}
  mbm.push(hdr1);
  mbm.push(hdr2);

  function mbmRow(label,vals){const row=[label];for(const v of vals)row.push(v!==null&&v!==undefined?fmt$(v):'');mbm.push(row);}

  // Income
  mbm.push(['--- INCOME ---']);
  mbmRow('Take-Home Income',plan.slice(0,N).map(m=>m.income));
  mbmRow('Windfalls This Month',plan.slice(0,N).map(m=>m.wfTotal>0?m.wfTotal:null));
  mbmRow('Total Income This Month',plan.slice(0,N).map(m=>m.totalIncomeThisMonth));

  // Regular expenses
  mbm.push(['--- REGULAR MONTHLY EXPENSES ---']);
  const regItems=(data.expenses.regular||[]).filter(e=>e.amount>0);
  for(const e of regItems)mbmRow(e.name,plan.slice(0,N).map(()=>e.amount));
  mbmRow('Subtotal — Regular',plan.slice(0,N).map(m=>m.regTotal));

  // Irregular
  mbm.push(['--- IRREGULAR / SEASONAL EXPENSES ---']);
  for(const ie of(data.expenses.irregular||[])){
    const ms=ie.mode==='spread'?'all months':(ie.months||[]).map(m=>MN[m]).join(', ');
    mbmRow(`${ie.name} (${ms})`,plan.slice(0,N).map(m=>{const found=m.irregItems.find(i=>i.name===ie.name);return found?found.amount:null;}));
  }
  mbmRow('Subtotal — Irregular',plan.slice(0,N).map(m=>m.irregTotal>0?m.irregTotal:null));

  // Cash flow
  mbm.push(['--- CASH FLOW SUMMARY ---']);
  mbmRow('Total Expenses',plan.slice(0,N).map(m=>m.totalExpenses));
  mbmRow('Net Surplus',plan.slice(0,N).map(m=>m.surplus));
  mbmRow('Total Debt Minimums',plan.slice(0,N).map(m=>m.totalMinimums));
  mbmRow('Extra Applied to Target Debt',plan.slice(0,N).map(m=>m.extraToTarget));

  // Payments
  mbm.push(['--- PAYMENTS THIS MONTH (What to Pay on Each Debt) ---']);
  for(const d of data.debts){
    mbmRow(`${d.name} — Minimum`,plan.slice(0,N).map(m=>{const dd=m.detail.find(x=>x.name===d.name);return dd&&dd.begBal>0?Math.round(dd.minPrincipal+dd.interest):null;}));
    mbmRow(`${d.name} — Extra`,plan.slice(0,N).map(m=>{const dd=m.detail.find(x=>x.name===d.name);return dd&&dd.extraPrincipal>0?Math.round(dd.extraPrincipal):null;}));
    mbmRow(`${d.name} — TOTAL SEND`,plan.slice(0,N).map(m=>{const dd=m.detail.find(x=>x.name===d.name);return dd&&dd.begBal>0?Math.round(dd.totalPaid):null;}));
  }
  mbmRow('TOTAL PAYMENTS THIS MONTH',plan.slice(0,N).map(m=>m.detail.filter(dd=>dd.begBal>0).reduce((s,dd)=>s+Math.round(dd.totalPaid),0)));

  // Balances
  mbm.push(['--- DEBT BALANCES (End of Month) ---']);
  for(const d of data.debts){
    const row=[d.name];
    for(let i=0;i<N;i++){
      const dd=plan[i].detail.find(x=>x.name===d.name);
      if(dd&&dd.endBal>0)row.push(fmt$(dd.endBal));
      else if(dd&&dd.begBal>0)row.push('PAID OFF');
      else row.push('');
    }
    mbm.push(row);
  }
  mbmRow('TOTAL REMAINING DEBT',plan.slice(0,N).map(m=>m.totalDebt));

  const wsMbm=utils.aoa_to_sheet(mbm);
  const mbmCols=[{wch:38}];for(let i=0;i<N;i++)mbmCols.push({wch:12});
  wsMbm['!cols']=mbmCols;
  utils.book_append_sheet(wb,wsMbm,'Month-by-Month');

  // ── YEAR-BY-YEAR ──
  const yy=[];
  yy.push(['YEAR-BY-YEAR DEBT PAYOFF DETAIL']);
  yy.push(['Per-loan breakdown · Beg Balance · Min/Mo · Interest Paid · Min Principal · Extra Principal · Total Paid · End Balance']);
  yy.push([]);
  for(const yd of yoy){
    yy.push([`${yd.year}`]);
    for(const b of yd.bullets)yy.push([`  ${b}`]);
    yy.push(['Loan','Beg Balance','Min/Mo','Interest Paid','Min Principal','Extra Principal','Total Paid','End Balance']);
    for(const dr of yd.debtRows){
      const paid=dr.endBal===0;
      yy.push([
        `${dr.isTarget?'[TARGET] ':''}${paid?'[PAID] ':''}${dr.name}${dr.payoffMonth?` — PAID OFF ${dr.payoffMonth}`:''}`,
        fmt$(dr.begBal),fmt$(dr.minPerMo),fmt$(Math.round(dr.interest)),
        fmt$(Math.round(dr.minPrincipal)),dr.extraPrincipal>0?fmt$(Math.round(dr.extraPrincipal)):'',
        fmt$(Math.round(dr.totalPaid)),paid?'PAID OFF':fmt$(dr.endBal)
      ]);
    }
    yy.push(['YEAR TOTALS',fmt$(Math.round(yd.bt)),'',fmt$(Math.round(yd.yi)),'',fmt$(Math.round(yd.ye)),fmt$(Math.round(yd.yp)),fmt$(Math.round(yd.et))]);
    yy.push([]);
  }
  const ti=yoy.reduce((s,y)=>s+y.yi,0);
  yy.push([`DEBT FREE: ${debtFree}   |   Total Interest Paid: ${fmt$(Math.round(ti))}   |   Plan Length: ${plan.length} months`]);
  const wsYy=utils.aoa_to_sheet(yy);
  wsYy['!cols']=[{wch:40},{wch:14},{wch:10},{wch:14},{wch:14},{wch:16},{wch:12},{wch:14}];
  utils.book_append_sheet(wb,wsYy,'Year-by-Year');

  // ── CHANGELOG ──
  const cl=[];
  cl.push(['VERSION HISTORY — DEBT PAYOFF PLANNER']);
  cl.push(['Version','Date','File(s)','What Changed']);
  cl.push(['v1.0','2026-03-09','Template, PDF, Prompt','Initial release.']);
  cl.push(['v1.1','2026-03-09','Template','Added Monthly Cash Flow Matrix tab.']);
  cl.push(['v1.2','2026-03-09','Template','Full rebuild: 4 tabs. My Plan · Month-by-Month · Year-by-Year · Changelog.']);
  const wsCl=utils.aoa_to_sheet(cl);
  wsCl['!cols']=[{wch:10},{wch:12},{wch:22},{wch:60}];
  utils.book_append_sheet(wb,wsCl,'CHANGELOG');

  return wb;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const data=req.body;
    if(!data.debts||!data.attack_order||!data.monthly_committed)
      return res.status(400).json({error:'Missing required fields'});

    const plan=simulate(data);
    if(!plan||plan.length===0)return res.status(400).json({error:'Simulation produced no results'});

    const debtFree=plan[plan.length-1].label;
    const yoy=buildYOY(plan,data);
    const wb=buildWorkbook(data,plan,yoy,debtFree);

    const buf=write(wb,{type:'buffer',bookType:'xlsx'});
    const fileName=`${(data.meta?.name||'DebtPlan').replace(/[^a-zA-Z0-9]/g,'_')}_DebtPayoffPlan.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
    res.send(buf);
  }catch(err){
    console.error('generate error:',err?.message,err?.stack);
    if(!res.headersSent)res.status(500).json({error:err.message||'Unknown error'});
  }
}

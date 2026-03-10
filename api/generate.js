import ExcelJS from ‘exceljs’;

const C = {
NAVY:‘FF1F3864’,BLUE_MED:‘FF2E75B6’,BLUE_LT:‘FFBDD7EE’,
GREEN_BG:‘FFE2EFDA’,GREEN_DK:‘FF375623’,RED_BG:‘FFFCE4D6’,
RED_DK:‘FFC00000’,GOLD_LT:‘FFFFF2CC’,GOLD:‘FFBF9000’,
GREY:‘FFF2F2F2’,GREY_MED:‘FFD9D9D9’,WHITE:‘FFFFFFFF’,BLACK:‘FF000000’,
};
const MN=[’’,‘Jan’,‘Feb’,‘Mar’,‘Apr’,‘May’,‘Jun’,‘Jul’,‘Aug’,‘Sep’,‘Oct’,‘Nov’,‘Dec’];
const CURR=’”$”#,##0;(”$”#,##0);”-”’;
const PCT=‘0.00%’;
const r2=(n)=>Math.round(n*100)/100;

// ── SIMULATION ────────────────────────────────────────────────────────────────
function simulate(data){
const{income,expenses,debts,attack_order,monthly_committed,windfalls=[],meta}=data;
const ds=debts.map(d=>({…d}));

const irregLkp={};
for(const ie of(expenses.irregular||[])){
const months=ie.mode===‘spread’?[1,2,3,4,5,6,7,8,9,10,11,12]:(ie.months||[]);
for(const m of months){
const amt=ie.mode===‘spread’?ie.amount/12:ie.amount;
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

```
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
```

}
return plan;
}

// ── YOY ───────────────────────────────────────────────────────────────────────
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
for(const[wMo,wn,wa]of yd.windfalls)bullets.push(`📌 ${wMo}: ${wn} ($${Math.round(wa).toLocaleString()}) applied as lump sum to target debt.`);
for(const[pMo,dn]of yd.payoffs){
const idx=attack_order.indexOf(dn);
const nxt=idx>=0&&idx+1<attack_order.length?attack_order[idx+1]:null;
const freed=debts.find(d=>d.name===dn)?.min||0;
bullets.push(`✓  ${dn} PAID OFF — ${pMo}.${nxt?` $${freed.toLocaleString()}/mo cascades → ${nxt}.`:' YOU ARE DEBT FREE!'}`);
}
for(const ic of(income.income_changes||[]).filter(ic=>ic.year===yd.year))
bullets.push(`📌 ${MN[ic.month]} ${yd.year}: ${ic.note} — surplus +$${ic.delta.toLocaleString()}/mo.`);
if(!bullets.length){const tgt=debtRows.find(r=>r.isTarget);if(tgt)bullets.push(`📌 Full surplus directed to ${tgt.name} all year.`);}
return{year:yd.year,debtRows,yi,ym:ym2,ye,yp,bt,et,bullets};
});
}

// ── STYLE HELPERS ─────────────────────────────────────────────────────────────
function sty(cell,{bold=false,italic=false,size=10,color=C.BLACK,bg=C.WHITE,hAlign=‘left’,vAlign=‘middle’,wrap=false,numFmt=null,border=true}={}){
cell.font={name:‘Arial’,bold,italic,size,color:{argb:color}};
cell.fill={type:‘pattern’,pattern:‘solid’,fgColor:{argb:bg}};
cell.alignment={horizontal:hAlign,vertical:vAlign,wrapText:wrap};
if(numFmt)cell.numFmt=numFmt;
if(border){const bs={style:‘thin’,color:{argb:‘FFBFBFBF’}};cell.border={top:bs,left:bs,bottom:bs,right:bs};}
}
function mrow(ws,r,c1,c2,val,opts={}){ws.mergeCells(r,c1,r,c2);const cell=ws.getCell(r,c1);cell.value=val;sty(cell,opts);return cell;}
function hdr(ws,r,c,text,span,{bg=C.NAVY,fg=C.WHITE,size=10,height=26}={}){
ws.getRow(r).height=height;
if(span>1)ws.mergeCells(r,c,r,c+span-1);
const cell=ws.getCell(r,c);cell.value=`  ${text}`;
sty(cell,{bold:true,size,color:fg,bg,hAlign:‘left’,border:false});
}
function colHdrs(ws,r,items,height=26){
ws.getRow(r).height=height;
for(const[col,txt]of items){const cell=ws.getCell(r,col);cell.value=txt;sty(cell,{bold:true,size:9,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’,vAlign:‘middle’,wrap:true,border:false});}
}

// ── TAB: START HERE ───────────────────────────────────────────────────────────
function buildStartHere(wb,data,debtFree){
const ws=wb.addWorksheet(‘START HERE’);
ws.views=[{showGridLines:false}];
[[‘A’,2],[‘B’,22],[‘C’,22],[‘D’,22],[‘E’,22],[‘F’,2]].forEach(([c,w])=>ws.getColumn(c).width=w);
const{meta}=data;let r=1;

function W(text,opts={}){
const{bold=false,italic=false,size=10,color=C.BLACK,bg=C.WHITE,hAlign=‘left’,height=20,wrap=true}=opts;
ws.getRow(r).height=height;ws.mergeCells(r,2,r,5);
sty(ws.getCell(r,2),{bold,italic,size,color,bg,hAlign,vAlign:‘middle’,wrap});ws.getCell(r,2).value=text;r++;
}
function W2(left,right,{height=28,lBold=false,lBg=C.BLUE_LT,rBg=C.WHITE,lColor=C.NAVY,rColor=C.BLACK}={}){
ws.getRow(r).height=height;ws.mergeCells(r,2,r,3);ws.mergeCells(r,4,r,5);
const lc=ws.getCell(r,2);lc.value=`  ${left}`;sty(lc,{bold:lBold,size:9,color:lColor,bg:lBg,wrap:true});
const rc=ws.getCell(r,4);rc.value=`  ${right}`;sty(rc,{size:9,color:rColor,bg:rBg,wrap:true});r++;
}
function SHDR(t,bg=C.NAVY,fg=C.WHITE){W(`  ${t}`,{bold:true,size:11,color:fg,bg,hAlign:‘left’,height:30,wrap:false});}
function SP(h=6){ws.getRow(r).height=h;r++;}

W(‘DEBT PAYOFF PLANNER’,{bold:true,size:22,color:C.WHITE,bg:C.NAVY,hAlign:‘center’,height:52});
W(`Your personalized AI-generated debt elimination plan  ·  Generated ${meta.generated}  ·  Strategy: ${meta.strategy}  ·  Debt-Free Target: ${debtFree}`,{size:10,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’,height:26});
SP();

SHDR(‘WHAT IS THIS FILE?’);
W(’     This spreadsheet is your complete, personalized debt payoff plan — built specifically for you based on your income, expenses, and debts, and calculated month by month until you are completely debt free.’,{height:44});
W(’     The plan shows you exactly what to pay on each debt every month, how your balances shrink over time, when each debt disappears, and how much interest you save compared to making only minimum payments forever.’,{height:44});
SP();

SHDR(“WHAT’S IN EACH TAB”,C.BLUE_MED);
ws.getRow(r).height=24;ws.mergeCells(r,3,r,4);
for(const[c,t]of[[2,‘TAB’],[3,‘WHAT IT SHOWS’],[5,‘WHEN TO USE IT’]]){const cell=ws.getCell(r,c);cell.value=t;sty(cell,{bold:true,size:9,color:C.WHITE,bg:C.NAVY,hAlign:‘center’,border:false});}
[4,5].forEach(c=>{ws.getCell(r,c).fill={type:‘pattern’,pattern:‘solid’,fgColor:{argb:C.NAVY}};});r++;

[[‘START HERE’,‘Overview, instructions, color guide, and disclaimers.’,‘Once at the start. Return anytime you have questions.’],
[‘My Plan’,‘Strategy summary, attack order, milestone dates, and plain-English plan explanation.’,‘Read first. Refer back for the big picture.’],
[‘Month-by-Month’,‘24 months of full detail: every expense, what to pay on each debt, ending balances.’,‘Every month — your primary action tab.’],
[‘Year-by-Year’,‘Full timeline to debt-free: per-loan interest, principal, extra payments, end balances.’,‘Review annually against your actual progress.’],
[‘CHANGELOG’,‘Version history of this file and product bundle.’,‘Reference only.’]
].forEach(([tab,what,when],i)=>{
const bg=tab===‘Month-by-Month’?C.GOLD_LT:(i%2===0?C.WHITE:C.GREY);
ws.getRow(r).height=36;ws.mergeCells(r,3,r,4);
[[2,`  ${tab}`,true],[3,`  ${what}`,false],[5,`  ${when}`,false]].forEach(([c,v,b])=>{sty(ws.getCell(r,c),{bold:b,size:9,color:b?C.NAVY:C.BLACK,bg,wrap:true});ws.getCell(r,c).value=v;});
ws.getCell(r,4).fill={type:‘pattern’,pattern:‘solid’,fgColor:{argb:bg}};r++;
});
SP();

SHDR(‘HOW TO USE THIS PLAN  —  STEP BY STEP’);
[[‘Step 1  —  Read your plan’,“Open MY PLAN. Read the strategy and attack order. Add the milestone dates to your calendar.”,C.WHITE],
[‘Step 2  —  Act every month  ← THE MOST IMPORTANT STEP’,‘Open MONTH-BY-MONTH. Find the current month. Look at PAYMENTS THIS MONTH. Pay exactly those amounts.’,C.GOLD_LT],
[‘Step 3  —  Apply windfalls immediately’,‘Tax refund, bonus, unexpected cash? Apply it directly to your current target debt immediately.’,C.WHITE],
[‘Step 4  —  Review annually’,‘Once a year compare where you actually are to the projection.’,C.WHITE],
[‘Step 5  —  Start over if anything big changes’,‘Re-running the AI interview takes 15 minutes and gives you a fresh plan.’,C.WHITE],
].forEach(([t,tx,bg])=>{
W(`  ${t}`,{bold:true,size:9,color:C.NAVY,bg:bg===C.WHITE?C.BLUE_LT:C.GOLD,height:22});
W(`     ${tx}`,{size:9,bg,height:Math.max(36,Math.floor(tx.length/4)+18),wrap:true});
});
SP();

SHDR(‘WHEN TO START OVER  —  RE-RUN THE AI INTERVIEW’,C.RED_BG,C.RED_DK);
W(’     This plan is a point-in-time snapshot. These changes warrant a fresh plan:’,{size:9,height:32,wrap:true});
[[‘💼  Income changes ±$500+/mo’,‘New job, raise, pay cut, spouse starts/stops working.’],
[‘💳  You take on new debt’,‘New car loan, credit card balance, personal loan, or medical payment plan.’],
[‘🏦  You refinance any debt’,‘Rate and/or payment changes — the entire cascade math shifts.’],
[‘💸  Expenses change significantly’,‘New home, new childcare, major insurance change.’],
[‘⚠️  Off-plan for 3+ months’,‘A fresh plan reflects where you actually are, not where you were.’],
].forEach(([l,r2],i)=>W2(l,r2,{height:32,lBold:true,lBg:C.RED_BG,rBg:i%2===0?C.WHITE:C.GREY,lColor:C.RED_DK}));
SP();

SHDR(‘IMPORTANT DISCLAIMERS’);
[‘NOT FINANCIAL ADVICE  —  This plan is a calculation tool, not professional financial advice. It was generated by an AI assistant based on information you provided. The creator is not a licensed financial advisor.’,
‘ACCURACY OF INPUTS  —  The quality of this plan depends on the accuracy of the information provided. Estimated or incorrect balances, rates, income, or expenses will cause projected dates to differ from reality.’,
‘VARIABLE RATE LOANS  —  If any debts have variable rates (e.g., a HELOC), your actual costs may differ. The plan uses the rate at time of generation.’,
‘NO GUARANTEE OF RESULTS  —  Debt payoff timelines depend on consistent execution, stable income, and the absence of major financial events. This is a projection.’,
‘CONSULT A PROFESSIONAL  —  For complex situations involving taxes, bankruptcy, or retirement, please consult a licensed financial advisor or credit counselor.’,
].forEach((t,i)=>W(`     ${t}`,{size:9,bg:i%2===0?C.WHITE:C.GREY,height:Math.max(40,Math.floor(t.length/5)+20),wrap:true}));
SP();
W(`Debt Payoff Planner  v1.2  ·  Generated ${meta.generated}  ·  Plan for: ${meta.name}  ·  Debt-Free Target: ${debtFree}`,{italic:true,size:8,color:C.WHITE,bg:C.NAVY,hAlign:‘center’,height:22});
}

// ── TAB: MY PLAN ──────────────────────────────────────────────────────────────
function buildMyPlan(wb,data,plan,debtFree){
const ws=wb.addWorksheet(‘My Plan’);
ws.views=[{showGridLines:false}];
[[‘A’,2],[‘B’,36],[‘C’,18],[‘D’,18],[‘E’,18],[‘F’,18],[‘G’,2]].forEach(([c,w])=>ws.getColumn(c).width=w);
const{meta,debts,attack_order,income,expenses}=data;

ws.getRow(1).height=44;
mrow(ws,1,1,6,`DEBT PAYOFF PLAN  —  ${meta.name.toUpperCase()}`,{bold:true,size:16,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});
ws.getRow(2).height=22;
mrow(ws,2,1,6,`Generated ${meta.generated}   ·   Strategy: ${meta.strategy}   ·   Debt-Free Target: ${debtFree}`,{size:10,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’});

let r=4;
hdr(ws,r,1,‘FINANCIAL SNAPSHOT’,6,{height:28});r++;
const regTotal=(expenses.regular||[]).reduce((s,e)=>s+e.amount,0);
const irregAnnual=(expenses.irregular||[]).reduce((s,ie)=>s+ie.amount*((ie.mode===‘spread’?12:(ie.months||[]).length)),0)/12;

[[`Monthly Take-Home Income`,income.monthly_takehome,CURR,C.WHITE],
[‘Monthly Regular Expenses’,regTotal,CURR,C.WHITE],
[‘Monthly Avg — Irregular/Seasonal Costs’,irregAnnual,CURR,C.WHITE],
[‘Average True Monthly Surplus’,income.monthly_takehome-regTotal-irregAnnual,CURR,C.GOLD_LT],
[`Emergency Fund  (Current / Target)`,`$${(data.goals?.emergency_fund_current||0).toLocaleString()}  /  $${(data.goals?.emergency_fund_target||0).toLocaleString()}`,null,C.WHITE],
].forEach(([lbl,val,fmt,bg])=>{
ws.getRow(r).height=22;
const lc=ws.getCell(r,2);lc.value=`  ${lbl}`;sty(lc,{bg:bg===C.WHITE?C.BLUE_LT:bg});
ws.mergeCells(r,3,r,6);const vc=ws.getCell(r,3);vc.value=val;
sty(vc,{bold:true,color:C.NAVY,bg,hAlign:‘center’});if(fmt)vc.numFmt=fmt;r++;
});
r++;

hdr(ws,r,1,`DEBT ATTACK ORDER  (${meta.strategy})`,6,{height:28});r++;
colHdrs(ws,r,[[2,‘Priority’],[3,‘Debt Name’],[4,‘Current Balance’],[5,‘Rate’],[6,‘Min Payment/Mo’]],24);r++;
attack_order.forEach((ao,i)=>{
const debt=debts.find(d=>d.name===ao);if(!debt)return;
const bg=i===0?C.GOLD_LT:(i%2===0?C.WHITE:C.GREY);
ws.getRow(r).height=24;
const sc=ws.getCell(r,2);sc.value=`  #${i+1}${i===0?'  ← ATTACKING NOW':''}`;sty(sc,{bold:i===0,size:9,color:i===0?C.NAVY:C.BLACK,bg});
const nc=ws.getCell(r,3);nc.value=debt.name;sty(nc,{bold:i===0,size:9,color:i===0?C.NAVY:C.BLACK,bg,hAlign:‘center’});
const bc=ws.getCell(r,4);bc.value=debt.balance;sty(bc,{bold:i===0,color:i===0?C.RED_DK:C.BLACK,bg,hAlign:‘center’});bc.numFmt=CURR;
const rc2=ws.getCell(r,5);rc2.value=debt.rate;sty(rc2,{bg,hAlign:‘center’});rc2.numFmt=PCT;
const mc=ws.getCell(r,6);mc.value=debt.min;sty(mc,{bg,hAlign:‘center’});mc.numFmt=CURR;r++;
});
ws.getRow(r).height=24;
const tc=ws.getCell(r,2);tc.value=’  TOTAL’;sty(tc,{bold:true,size:9,color:C.WHITE,bg:C.NAVY});
[3,5].forEach(c=>sty(ws.getCell(r,c),{bg:C.NAVY}));
const totB=ws.getCell(r,4);totB.value=debts.reduce((s,d)=>s+d.balance,0);sty(totB,{bold:true,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});totB.numFmt=CURR;
const totM=ws.getCell(r,6);totM.value=debts.reduce((s,d)=>s+d.min,0);sty(totM,{bold:true,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});totM.numFmt=CURR;
r+=2;

hdr(ws,r,1,‘KEY MILESTONES  —  DATES TO CELEBRATE’,6,{bg:C.NAVY,height:28});r++;
colHdrs(ws,r,[[2,‘When’],[3,‘Milestone’],[4,’’],[5,’’],[6,’’]],22);ws.mergeCells(r,3,r,6);r++;
for(const m of plan){
for(const dd of m.detail){
if(!dd.paidOffNow)continue;
const idx=attack_order.indexOf(dd.name);
const nxt=idx>=0&&idx+1<attack_order.length?attack_order[idx+1]:null;
const freed=debts.find(d=>d.name===dd.name)?.min||0;
const note=nxt?`$${freed.toLocaleString()}/mo freed → cascades into ${nxt}`:‘YOU ARE DEBT FREE 🎉’;
const bg=nxt?C.GREEN_BG:C.GOLD_LT;
ws.getRow(r).height=26;
const dc=ws.getCell(r,2);dc.value=`  ${m.label}`;sty(dc,{bold:true,size:9,color:C.NAVY,bg,hAlign:‘center’});
ws.mergeCells(r,3,r,6);const mc2=ws.getCell(r,3);mc2.value=`🎉  ${dd.name}  PAID OFF  —  ${note}`;sty(mc2,{bold:true,size:9,color:C.GREEN_DK,bg});r++;
}
}
r++;

hdr(ws,r,1,‘YOUR STRATEGY IN PLAIN ENGLISH’,6,{bg:C.BLUE_MED,height:28});r++;
ws.getRow(r).height=80;ws.mergeCells(r,2,r,6);
const fTarget=attack_order[0];const fDebt=debts.find(d=>d.name===fTarget);
const rateStr=fDebt?`(${(fDebt.rate*100).toFixed(2)}%)`:’’;
const wfSentence=(data.windfalls||[]).length>0?` Windfalls are applied as lump sums to the current target debt.`:’’;
const sc2=ws.getCell(r,2);
sc2.value=`You are using the ${meta.strategy.toUpperCase()} method. Every dollar of surplus above minimum payments goes to ${fTarget} ${rateStr} until eliminated. When paid off, that freed payment cascades to the next debt.${wfSentence} Stay consistent and you will reach debt freedom by ${debtFree}.`;
sty(sc2,{wrap:true,vAlign:‘top’});r+=2;
ws.mergeCells(r,1,r,7);const fc=ws.getCell(r,1);fc.value=‘Debt Payoff Planner  v1.2  ·  Projection based on information provided. Not financial advice.’;
fc.font={name:‘Arial’,size:8,italic:true,color:{argb:‘FF999999’}};fc.alignment={horizontal:‘center’};ws.getRow(r).height=18;
}

// ── TAB: MONTH-BY-MONTH ───────────────────────────────────────────────────────
function buildMonthByMonth(wb,data,plan){
const ws=wb.addWorksheet(‘Month-by-Month’);
ws.views=[{showGridLines:false,state:‘frozen’,xSplit:1,ySplit:4}];
const{debts,expenses}=data;
const N=Math.min(24,plan.length);const LC=2;const FC=3;
ws.getColumn(‘A’).width=2;ws.getColumn(LC).width=30;
for(let i=0;i<N;i++)ws.getColumn(FC+i).width=11;

ws.getRow(1).height=40;ws.mergeCells(1,1,1,FC+N-1);
sty(ws.getCell(1,1),{bold:true,size:14,color:C.WHITE,bg:C.NAVY,hAlign:‘center’,border:false});
ws.getCell(1,1).value=‘MONTH-BY-MONTH DETAIL  —  FIRST 24 MONTHS’;
ws.getRow(2).height=20;ws.mergeCells(2,1,2,FC+N-1);
sty(ws.getCell(2,1),{italic:true,size:9,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’,border:false});
ws.getCell(2,1).value=‘Full income · expense line items · debt balances for every month  ·  Irregular costs shown only in the month they hit’;

ws.getRow(3).height=18;ws.getRow(4).height=24;
for(let i=0;i<N;i++){
const col=FC+i;const m=plan[i];
const bgYr=i%2===0?C.NAVY:C.BLUE_MED;
const c3=ws.getCell(3,col);c3.value=String(m.year);sty(c3,{bold:true,size:8,color:C.WHITE,bg:bgYr,hAlign:‘center’,border:false});
const c4=ws.getCell(4,col);c4.value=MN[m.month];sty(c4,{bold:true,size:10,color:C.WHITE,bg:C.NAVY,hAlign:‘center’,border:false});
}

const rowDefs=[];let r=5;
function SR(label,bg=C.NAVY,fg=C.WHITE){
ws.getRow(r).height=22;const cell=ws.getCell(r,LC);cell.value=`  ${label}`;
sty(cell,{bold:true,size:9,color:fg,bg,border:false});rowDefs.push({r,type:‘section’,bg});r++;
}
function DR(label,key,bold=false,bg=C.WHITE,h=18){
ws.getRow(r).height=h;const cell=ws.getCell(r,LC);cell.value=`  ${label}`;
sty(cell,{bold,size:9,color:C.BLACK,bg});rowDefs.push({r,type:‘data’,key,bold,bg});r++;
}

SR(‘INCOME’);
DR(‘Take-Home Income’,‘income’,false,C.WHITE,20);
DR(‘Windfalls This Month’,‘wf_total’,false,C.GREEN_BG,20);
DR(‘Total Income This Month’,‘total_income’,true,C.BLUE_LT,22);
SR(‘REGULAR MONTHLY EXPENSES’);
const regItems=(expenses.regular||[]).filter(e=>e.amount>0);
for(const e of regItems)DR(e.name,`reg_${e.name}`,false,C.WHITE,18);
DR(‘Subtotal — Regular’,‘reg_total’,true,C.GREY_MED,20);
SR(‘IRREGULAR / SEASONAL EXPENSES’,C.BLUE_MED);
const irregAll=expenses.irregular||[];
for(const ie of irregAll){
const ms=ie.mode===‘spread’?‘all months’:(ie.months||[]).map(m=>MN[m]).join(’, ’);
DR(`${ie.name}  (${ms})`,`irreg_${ie.name}`,false,C.WHITE,18);
}
DR(‘Subtotal — Irregular’,‘irreg_total’,true,C.GREY_MED,20);
SR(‘CASH FLOW SUMMARY’);
DR(‘Total Expenses’,‘total_expenses’,true,C.GREY_MED,20);
DR(‘Net Surplus’,‘surplus’,true,C.GOLD_LT,22);
DR(‘Total Debt Minimums’,‘total_minimums’,false,C.WHITE,20);
DR(‘Extra Applied to Target Debt’,‘extra_to_target’,true,C.GREEN_BG,22);
SR(‘PAYMENTS THIS MONTH  (What to Pay on Each Debt)’,C.NAVY);
for(const d of debts){
DR(`  ${d.name}  —  Minimum`,`pay_min_${d.name}`,false,C.WHITE,18);
DR(`  ${d.name}  —  Extra`,`pay_ext_${d.name}`,false,C.GREEN_BG,18);
DR(`  ${d.name}  —  TOTAL SEND`,`pay_tot_${d.name}`,true,C.GOLD_LT,22);
}
DR(‘TOTAL PAYMENTS THIS MONTH’,‘total_payments’,true,C.BLUE_LT,24);
SR(‘DEBT BALANCES  (End of Month)’);
for(const d of debts)DR(d.name,`debt_${d.name}`,false,C.WHITE,22);
DR(‘TOTAL REMAINING DEBT’,‘total_debt’,true,C.BLUE_LT,24);

const origBals={};for(const d of debts)origBals[d.name]=d.balance;

for(let mi=0;mi<N;mi++){
const col=FC+mi;const m=plan[mi];
const irrT={};for(const i of m.irregItems)irrT[i.name]=i.amount;
const md={income:m.income,wf_total:m.wfTotal>0?m.wfTotal:null,total_income:m.totalIncomeThisMonth,reg_total:m.regTotal,irreg_total:m.irregTotal>0?m.irregTotal:null,total_expenses:m.totalExpenses,surplus:m.surplus,total_minimums:m.totalMinimums,extra_to_target:m.extraToTarget,total_debt:m.totalDebt};
for(const e of regItems)md[`reg_${e.name}`]=e.amount;
for(const ie of irregAll)md[`irreg_${ie.name}`]=irrT[ie.name]??null;
for(const dd of m.detail){
md[`debt_${dd.name}`]=dd.endBal>0?dd.endBal:null;
md[`pay_min_${dd.name}`]=dd.begBal>0?Math.round(dd.minPrincipal+dd.interest):null;
md[`pay_ext_${dd.name}`]=dd.extraPrincipal>0?Math.round(dd.extraPrincipal):null;
md[`pay_tot_${dd.name}`]=dd.begBal>0?Math.round(dd.totalPaid):null;
}
md.total_payments=m.detail.filter(dd=>dd.begBal>0).reduce((s,dd)=>s+Math.round(dd.totalPaid),0);

```
for(const rd of rowDefs){
  const cell=ws.getCell(rd.r,col);
  if(rd.type==='section'){sty(cell,{bg:rd.bg,border:false});continue;}
  const{key}=rd;const val=md[key];
  let bg=rd.bg;
  if(key==='wf_total')bg=val?C.GREEN_BG:C.WHITE;
  else if(key==='irreg_total')bg=val?C.RED_BG:C.GREY_MED;
  else if(key.startsWith('irreg_'))bg=val?C.RED_BG:C.WHITE;
  else if(key==='surplus')bg=C.GOLD_LT;
  else if(key==='extra_to_target')bg=C.GREEN_BG;
  else if(key==='total_income')bg=C.BLUE_LT;
  else if(['reg_total','total_expenses','total_minimums'].includes(key))bg=C.GREY_MED;
  else if(key==='total_debt'||key==='total_payments')bg=C.BLUE_LT;
  else if(key.startsWith('pay_min_'))bg=C.WHITE;
  else if(key.startsWith('pay_ext_'))bg=val?C.GREEN_BG:C.WHITE;
  else if(key.startsWith('pay_tot_'))bg=val?C.GOLD_LT:C.WHITE;
  else if(key.startsWith('debt_')){const dn=key.slice(5);bg=m.target===dn?C.GOLD_LT:(val===null?C.GREEN_BG:C.WHITE);}

  if(key.startsWith('debt_')&&val===null&&origBals[key.slice(5)]>0){cell.value='PAID OFF ✓';sty(cell,{bold:true,size:8,color:C.GREEN_DK,bg:C.GREEN_BG,hAlign:'center'});continue;}
  if(key.startsWith('pay_')&&val===null){
    const dn=key.split('_').slice(2).join('_');
    const dd=m.detail.find(d=>d.name===dn);
    if(dd&&dd.endBal===0&&dd.begBal===0&&origBals[dn]>0){cell.value='PAID OFF ✓';sty(cell,{bold:true,size:8,color:C.GREEN_DK,bg:C.GREEN_BG,hAlign:'center'});continue;}
  }
  if(val===null||val===undefined){sty(cell,{bg,hAlign:'center'});continue;}
  cell.value=val;
  sty(cell,{bold:rd.bold,size:9,color:rd.bold&&[C.BLUE_LT,C.GOLD_LT].includes(bg)?C.NAVY:C.BLACK,bg,hAlign:'center'});
  cell.numFmt=CURR;
}
```

}
if(plan.length>24){
ws.getRow(r).height=28;ws.mergeCells(r,LC,r,FC+N-1);
const fc=ws.getCell(r,LC);fc.value=`  📌  First 24 months shown.  Full plan = ${plan.length} months  ·  See Year-by-Year tab for complete timeline.`;
sty(fc,{italic:true,size:9,color:C.GOLD,bg:C.GOLD_LT,wrap:true});
}
}

// ── TAB: YEAR-BY-YEAR ─────────────────────────────────────────────────────────
function buildYearByYear(wb,data,yoy,plan,debtFree){
const ws=wb.addWorksheet(‘Year-by-Year’);
ws.views=[{showGridLines:false}];
[[‘A’,2],[‘B’,46],[‘C’,14],[‘D’,11],[‘E’,13],[‘F’,13],[‘G’,14],[‘H’,13],[‘I’,14],[‘J’,2]].forEach(([c,w])=>ws.getColumn(c).width=w);
ws.getRow(1).height=40;mrow(ws,1,1,9,‘YEAR-BY-YEAR DEBT PAYOFF DETAIL’,{bold:true,size:14,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});
ws.getRow(2).height=20;mrow(ws,2,1,9,‘Per-loan breakdown every year  ·  Beg Balance · Min/Mo · Interest Paid · Min Principal · Extra Principal · Total Paid · End Balance’,{italic:true,size:9,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’});
let r=4;const[B,C2,D,E,F,G,H,I]=[2,3,4,5,6,7,8,9];

for(const yd of yoy){
ws.getRow(r).height=32;ws.mergeCells(r,B,r,I);const yh=ws.getCell(r,B);yh.value=`  ${yd.year}`;sty(yh,{bold:true,size:14,color:C.WHITE,bg:C.NAVY});r++;
for(const bullet of yd.bullets){
ws.getRow(r).height=22;
const isPaid=bullet.includes(‘PAID OFF’)||bullet.includes(‘DEBT FREE’);
const bg=isPaid?C.GREEN_BG:(bullet.includes(‘📌’)?C.GOLD_LT:C.WHITE);
ws.mergeCells(r,B,r,I);const bc=ws.getCell(r,B);bc.value=`  ${bullet}`;sty(bc,{italic:true,size:9,color:isPaid?C.GREEN_DK:C.BLACK,bg,wrap:true});r++;
}
colHdrs(ws,r,[[B,‘Loan’],[C2,‘Beg Balance’],[D,‘Min/Mo’],[E,‘Interest Paid’],[F,‘Min Principal’],[G,‘Extra Principal’],[H,‘Total Paid’],[I,‘End Balance’]],28);r++;

```
for(const dr of yd.debtRows){
  const paid=dr.endBal===0;const bg=dr.isTarget?C.GOLD_LT:(paid?C.GREEN_BG:C.WHITE);
  let name=dr.name+(dr.payoffMonth?`  ✓ ${dr.payoffMonth}`:dr.isTarget?'  [SURPLUS TARGET]':'');
  ws.getRow(r).height=22;
  const nc=ws.getCell(r,B);nc.value=`${dr.isTarget?'★ ':paid?'✓ ':'  '}${name}`;sty(nc,{bold:dr.isTarget||paid,size:9,color:paid?C.GREEN_DK:dr.isTarget?C.NAVY:C.BLACK,bg});
  const cells=[[C2,dr.begBal,bg],[D,dr.minPerMo,bg],[F,Math.round(dr.minPrincipal),bg],[H,Math.round(dr.totalPaid),bg]];
  for(const[c,v,b]of cells){const cell=ws.getCell(r,c);cell.value=v;sty(cell,{bg:b,hAlign:'center'});cell.numFmt=CURR;}
  const intC=ws.getCell(r,E);intC.value=Math.round(dr.interest);sty(intC,{color:paid?C.GREEN_DK:C.RED_DK,bg:paid?bg:C.RED_BG,hAlign:'center'});intC.numFmt=CURR;
  const ep=Math.round(dr.extraPrincipal);const extC=ws.getCell(r,G);extC.value=ep>0?ep:null;sty(extC,{bold:ep>0,color:ep>0?C.GREEN_DK:C.BLACK,bg:ep>0?C.GREEN_BG:bg,hAlign:'center'});if(ep>0)extC.numFmt=CURR;
  const endC=ws.getCell(r,I);if(dr.endBal>0){endC.value=dr.endBal;sty(endC,{bg,hAlign:'center'});endC.numFmt=CURR;}else{endC.value=paid?'PAID OFF ✓':'-';sty(endC,{bold:paid,size:9,color:paid?C.GREEN_DK:C.BLACK,bg:paid?C.GREEN_BG:bg,hAlign:'center'});}r++;
}

ws.getRow(r).height=28;
const rc=ws.getCell(r,B);rc.value='  YEAR TOTALS';sty(rc,{bold:true,size:10,color:C.WHITE,bg:C.NAVY});
[[C2,Math.round(yd.bt),C.NAVY,C.WHITE],[D,'',C.NAVY,C.WHITE],[E,Math.round(yd.yi),C.RED_BG,C.RED_DK],
 [F,Math.round(yd.ym),C.NAVY,C.WHITE],[G,Math.round(yd.ye),C.GREEN_BG,C.GREEN_DK],
 [H,Math.round(yd.yp),C.NAVY,C.WHITE],[I,Math.round(yd.et),C.BLUE_LT,C.NAVY],
].forEach(([c,v,bg,color])=>{const cell=ws.getCell(r,c);cell.value=v;sty(cell,{bold:true,color,bg,hAlign:'center'});if(typeof v==='number'&&v!==0)cell.numFmt=CURR;});r+=2;
```

}

const ti=yoy.reduce((s,y)=>s+y.yi,0);
ws.getRow(r).height=40;ws.mergeCells(r,B,r,I);
const gc=ws.getCell(r,B);gc.value=`  🎉  DEBT FREE: ${debtFree}   ·   Total Interest Paid: $${Math.round(ti).toLocaleString()}   ·   Plan Length: ${plan.length} months`;
sty(gc,{bold:true,size:12,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});
}

// ── TAB: CHANGELOG ────────────────────────────────────────────────────────────
function buildChangelog(wb){
const ws=wb.addWorksheet(‘CHANGELOG’);
ws.views=[{showGridLines:false}];
[[‘A’,2],[‘B’,12],[‘C’,16],[‘D’,22],[‘E’,65],[‘F’,2]].forEach(([c,w])=>ws.getColumn(c).width=w);
ws.getRow(1).height=40;mrow(ws,1,1,5,‘VERSION HISTORY  —  DEBT PAYOFF PLANNER’,{bold:true,size:14,color:C.WHITE,bg:C.NAVY,hAlign:‘center’});
ws.getRow(2).height=20;mrow(ws,2,1,5,‘All changes to any file in this product bundle are tracked here’,{italic:true,size:9,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’});
ws.getRow(4).height=26;
for(const[c,t]of[[2,‘Version’],[3,‘Date’],[4,‘File(s)’],[5,‘What Changed’]]){const cell=ws.getCell(4,c);cell.value=t;sty(cell,{bold:true,size:10,color:C.WHITE,bg:C.BLUE_MED,hAlign:‘center’,border:false});}
[[‘v1.0’,‘2026-03-09’,‘Template, PDF, Prompt’,‘Initial release.’],
[‘v1.1’,‘2026-03-09’,‘Template’,‘Added Monthly Cash Flow Matrix tab and irregular/sunk costs to AI prompt.’],
[‘v1.2’,‘2026-03-09’,‘Template’,‘Full rebuild: 4 tabs. My Plan · Month-by-Month 24mo · Year-by-Year · Changelog. Static snapshot.’],
].forEach(([ver,dt,files,desc],i)=>{
const bg=i===2?C.GOLD_LT:C.WHITE;ws.getRow(5+i).height=40;
for(const[c,v]of[[2,ver],[3,dt],[4,files],[5,desc]]){
const cell=ws.getCell(5+i,c);cell.value=v;sty(cell,{bold:c===2,size:10,color:c===2?C.NAVY:C.BLACK,bg,hAlign:c<=3?‘center’:‘left’,wrap:true});
}
});
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req,res){
if(req.method!==‘POST’)return res.status(405).json({error:‘Method not allowed’});
try{
const data=req.body;
if(!data.debts||!data.attack_order||!data.monthly_committed)
return res.status(400).json({error:‘Missing required fields’});

```
const plan=simulate(data);
if(!plan||plan.length===0)return res.status(400).json({error:'Simulation produced no results'});

const debtFree=plan[plan.length-1].label;
const yoy=buildYOY(plan,data);

const wb=new ExcelJS.Workbook();
wb.creator='Clearpath — AI Debt Payoff Planner';
wb.created=new Date();

buildStartHere(wb,data,debtFree);
buildMyPlan(wb,data,plan,debtFree);
buildMonthByMonth(wb,data,plan);
buildYearByYear(wb,data,yoy,plan,debtFree);
buildChangelog(wb);

const fileName=`${(data.meta?.name||'DebtPlan').replace(/[^a-zA-Z0-9]/g,'_')}_DebtPayoffPlan.xlsx`;
res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
await wb.xlsx.write(res);
res.end();
```

}catch(err){
console.error(‘generate error:’,err);
res.status(500).json({error:err.message});
}
}

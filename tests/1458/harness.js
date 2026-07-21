#!/usr/bin/env node
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm");

const HTML=fs.readFileSync(path.join(__dirname,"..","..","accession-1458.html"),"utf8");
const m=HTML.match(/<script>\n([\s\S]*?)\n<\/script>/);
if(!m){console.error("no script block");process.exit(1)}
const SRC=m[1];

function fresh(){
	const sandbox={module:{exports:{}},console:console};
	vm.createContext(sandbox);
	vm.runInContext(SRC,sandbox,{filename:"accession-1458.js"});
	return sandbox.module.exports;
}
const E=fresh();

let pass=0,fail=0;
function check(name,cond,detail){
	if(cond){pass++;console.log("  ok  "+name)}
	else{fail++;console.error(" FAIL "+name+(detail?"  — "+detail:""))}
}
function tally(roll){const t={};Object.keys(roll).forEach(k=>{t[roll[k]]=(t[roll[k]]||0)+1});return t}

console.log("— data —");
const problems=E.validateData();
check("validateData clean",problems.length===0,problems.join("; "));
check("threshold 12 of 18",E.THRESHOLD===12&&E.THRESHOLD_N===18&&E.ELECTORS.length===18);
const fsz={};E.ELECTORS.forEach(c=>fsz[c.faction]=(fsz[c.faction]||0)+1);
check("faction sizes 8/5/2/2/1",fsz.italian===8&&fsz.catalan===5&&fsz.french===2&&fsz.greek===2&&fsz.avis===1,JSON.stringify(fsz));
const t1=tally(E.HIST_SCRUTINY_1);
check("scrutiny I documented totals",t1.piccolomini===5&&t1.calandrini===5&&t1.estouteville===3&&t1.torquemada===3&&t1.barbo===2,JSON.stringify(t1));
check("scrutiny I: nemo tres superavit",Object.keys(t1).every(c=>c==="piccolomini"||c==="calandrini"||t1[c]<=3));
const t2=tally(E.HIST_SCRUTINY_2);
check("scrutiny II nine and six",t2.piccolomini===9&&t2.estouteville===6&&(t2.calandrini||0)+(t2.torquemada||0)===3,JSON.stringify(t2));
const accs=E.HIST_ACCESSION.filter(b=>b.type==="accede");
check("documented accession order Borgia→Tebaldi→Colonna",accs.map(a=>a.id).join(",")==="borgia,tebaldi,colonna");
check("documented accessions lawful",accs.every(a=>E.HIST_SCRUTINY_2[a.id]!==a.to&&t2[a.to]>0));
check("Pius II is the only Piccolomini name",E.REGNAL.piccolomini.length===1&&E.REGNAL.piccolomini[0]==="Pius II");

console.log("— historical replay (observer) —");
const H=E.runHeadless("chronicle","mella","historical",10);
check("replay terminates elected",H.over===true&&!!H.electedId,JSON.stringify({over:H.over,el:H.electedId}));
check("replay elects Piccolomini as Pius II",H.electedId==="piccolomini"&&H.electedName==="Pius II",H.electedId+"/"+H.electedName);
check("replay uses exactly two scrutinies",H.history.length===2,String(H.history.length));
const r1=H.history[0],r2=H.history[1];
check("ballot 1 counts reproduce",r1.counts.piccolomini===5&&r1.counts.calandrini===5&&r1.counts.estouteville===3&&r1.counts.torquemada===3&&r1.counts.barbo===2,JSON.stringify(r1.counts));
check("ballot 2 written nine and six",r2.votes.filter(v=>v.candidate[0]==="piccolomini").length===9&&r2.votes.filter(v=>v.candidate[0]==="estouteville").length===6);
check("ballot 2 accession order",r2.accessions.map(a=>a.id).join(",")==="borgia,tebaldi,colonna",JSON.stringify(r2.accessions));
check("winner reaches exactly twelve",r2.counts.piccolomini===12,String(r2.counts.piccolomini));
check("pact was held and witnessed in chronicle",H.flags.pactHeld===true);
check("election integrity computed in range",H.finale&&H.finale.integrity>=5&&H.finale.integrity<=95,H.finale&&H.finale.integrity);
check("score within bounds",H.finale.score.total>=0&&H.finale.score.total<=100&&["A","B","C","D","E"].includes(H.finale.score.grade));
const partsSum=Object.values(H.finale.score.parts).reduce((a,b)=>a+b,0);
check("score parts sum to total",partsSum===H.finale.score.total,partsSum+" vs "+H.finale.score.total);

console.log("— historical replay (protagonists) —");
const HP=E.runHeadless("aeneas","piccolomini","historical",10);
check("as Piccolomini: elected, self",HP.over&&HP.electedId==="piccolomini"&&HP.playerId==="piccolomini");
check("as Piccolomini: regnal chosen Pius II",HP.electedName==="Pius II",String(HP.electedName));
check("as Piccolomini: vermiculo answered",HP.conscience.vermiculo===true);
check("as Piccolomini: midnight refused",HP.conscience.refusedPact===true);
const HC=E.runHeadless("hinge","colonna","historical",10);
check("as Colonna: breaks free and elects Pius",HC.over&&HC.electedId==="piccolomini"&&HC.conscience.brokeFree===true);
const HR=E.runHeadless("rouen","estouteville","historical",10);
check("as Rouen: pact held in the latrines, Pius still elected",HR.flags.pactHeld===true&&HR.electedId==="piccolomini",HR.electedId);
const HB=E.runHeadless("valentinus","borgia","historical",10);
check("as Borgia: first to accede",HB.history[1]&&HB.history[1].accessions[0]&&HB.history[1].accessions[0].id==="borgia");

console.log("— determinism —");
const D1=E.runHeadless("twin","barbo","open",10),D2=E.runHeadless("twin","barbo","open",10);
check("same seed, same world",D1.electedId===D2.electedId&&D1.history.length===D2.history.length&&D1.log.length===D2.log.length,
	D1.electedId+"/"+D2.electedId);
const D3=E.runHeadless("othertwin","barbo","open",10);
check("state isolated between runs",typeof D3.over==="boolean");

console.log("— termination & legality, Monte Carlo —");
let runs=0,elected=0,legal=true,within=true,thresholdOk=true,winners=new Set(),feverRose=true;
const seeds=["alpha","beta","gamma"];
for(const mode of ["historical","open"]){
	for(const c of E.IDS){
		for(const s of seeds){
			const R=E.runHeadless(s,c,mode,10);
			runs++;
			if(R.over&&R.electedId)elected++;else console.error("   unfinished:",mode,c,s);
			if(R.history.length>E.MAX_SCRUTINIES)within=false;
			winners.add(R.electedId);
			const last=R.history[R.history.length-1];
			if(last&&R.electedId){
				if((last.counts[R.electedId]||0)<E.THRESHOLD)thresholdOk=false;
			}
			for(const rec of R.history){
				const t=tally(Object.fromEntries(rec.votes.filter(v=>v.candidate[0]).map(v=>[v.voter,v.candidate[0]])));
				for(const a of rec.accessions){
					const wrote=(rec.votes.find(v=>v.voter===a.id)||{candidate:[]}).candidate[0];
					if(wrote===a.to)legal=false;
					if(!t[a.to])legal=false;
				}
				const seen={};
				rec.accessions.forEach(a=>{if(seen[a.id])legal=false;seen[a.id]=1});
			}
			if(R.history.length>=2&&R.metrics.fever<=E.BASE_METRICS.fever)feverRose=false;
		}
	}
}
check("all "+runs+" runs finish elected",elected===runs,elected+"/"+runs);
check("ballot count within MAX_SCRUTINIES",within);
check("every non-exhausted winner has twelve on the last record",thresholdOk);
check("accessus law holds in every recorded ballot",legal);
check("open mode yields more than one possible pope across seeds",(()=>{
	const w=new Set();
	for(const s of ["a","b","c","d","e","f","g","h","i","j","k","l"])w.add(E.runHeadless(s,"mella","open",10).electedId);
	return w.size>=2;
})());
check("the August fever ramps",feverRose);

console.log("— engine units —");
const S=E.initState("orsini","unit","open");
check("state save shape",(()=>{const j=JSON.parse(JSON.stringify(S));return j.playerId==="orsini"&&j.metrics&&j.lean&&j.flags&&Array.isArray(j.log)})());
check("enclosure label before capitulation",E.sessionLabel(S)==="Wednesday 16 August · the enclosure");
let threw=0;
try{E.validatePlayerPicks(S,["orsini"])}catch(e){threw++}
try{E.validatePlayerPicks(S,["nobody"])}catch(e){threw++}
try{E.validatePlayerPicks(S,["mella","barbo"])}catch(e){threw++}
check("ballot validation rejects self, stranger, and double papers",threw===3&&E.validatePlayerPicks(S,[])===null);
E.resolveDecision(S,"sign");
const p1=E.promiseOffice(S,"orsini","marches","tebaldi");
const p2=E.promiseOffice(S,"orsini","marches","mila");
check("double-promising the same office is flagged",p1.double===false&&p2.double===true);
let ownerThrew=false;
try{E.promiseOffice(S,"orsini","rouen","coetivy")}catch(e){ownerThrew=true}
check("Rouen's see is only Rouen's to promise",ownerThrew&&E.officeAvailableTo(S,"rouen","estouteville")===true);
let regThrew=false;
try{E.choosePlayerRegnalName({playerId:"barbo",electedId:"barbo"},"Leo X")}catch(e){regThrew=true}
check("regnal names limited to the candidate's list",regThrew);
const fc=E.forecastCounts(S);
check("forecast is deterministic for a state",JSON.stringify(fc)===JSON.stringify(E.forecastCounts(S)));
const snd=E.makeSounding(S);
check("soundings give lawful ranges",snd.rows.length>0&&snd.rows.every(r=>r.lo<=r.hi&&r.lo>=0&&r.hi<=18));

console.log("— boundary regressions —");
const blank=E.initState("mella","blank-paper","historical");
while(blank.pending)E.resolveDecision(blank,E.autoChoiceFor(blank));
const blankRecord=E.beginScrutiny(blank,[]);
const blankVote=blankRecord.votes.find(v=>v.voter==="mella");
check("a historical blank paper causes an honest divergence",blank.flags.divergedFromRecord===true&&blankRecord.scripted===false);
check("a submitted blank paper stays blank",blankVote&&blankVote.candidate.length===0);

const selfAccede=E.initState("piccolomini","self-accession","open");
while(selfAccede.pending)E.resolveDecision(selfAccede,E.autoChoiceFor(selfAccede));
E.beginScrutiny(selfAccede,[]);
selfAccede.accession.phase="live";
selfAccede.accession.leaderId="piccolomini";
check("the ballot leader cannot accede to himself",E.accessionEligible(selfAccede,"piccolomini")===false);
E.stageAccessionChoice(selfAccede,{act:"accede"});
E.stepAccession(selfAccede);
check("the public accession boundary ignores an illegal self-accession",!selfAccede.history[0].accessions.some(a=>a.id==="piccolomini"));
check("recorded accessions name both source and target",H.history.flatMap(r=>r.accessions).every(a=>a.from===a.id&&!!a.to));
check("saved states are versioned and validated",E.validateSavedState(JSON.parse(JSON.stringify(S))).schemaVersion===E.SAVE_SCHEMA);
let saveThrew=false;
try{E.validateSavedState({schemaVersion:999})}catch(e){saveThrew=true}
check("unknown saved-state versions are rejected",saveThrew);
check("no fabricated exhausted-acclamation fallback remains",!HTML.includes("by exhausted acclamation"));

console.log("— dependency-free page smoke —");
check("page links back to the conclave directory",HTML.includes('href="./index.html"'));
check("page exposes the browser engine",HTML.includes("window.__om=ACCESSION_1458_ENGINE"));
check("page has a live status region",HTML.includes('role="status" aria-live="polite"'));
check("page honours reduced motion",HTML.includes("prefers-reduced-motion:reduce"));
check("dossier rows are keyboard-operable buttons",HTML.includes("<button type='button' class='dosrow"));
check("hidden continuation and game panels cannot leak into view",HTML.includes("[hidden]{display:none!important}"));
check("mobile metrics use a stable two-column grid",HTML.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));

console.log("\n"+pass+" passed, "+fail+" failed");
process.exit(fail?1:0);

/**
 * The one page of a node. It is the gate while pre-flight has something to fix (a first run signs
 * in to GitHub and builds or picks an organization; a later failure shows the check and its fix in
 * place) and becomes the dashboard by itself when every check passes: the organization on the
 * left, the activity in the middle, the work and the front desk on the right. The header never
 * scrolls; each panel scrolls inside. Everything comes from one JSON state over server-sent events.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>dashing-agent</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme:dark;
  --bg:#0b1424; --surface:#111d33; --surface-2:#182946; --line:#253a5c;
  --ink:#ede7d8; --ink-2:#a9b3c8; --ink-3:#74829e;
  --accent:#e6a44a; --accent-ink:#1d1405;
  --good:#44c07f; --warn:#f0c252; --bad:#ec6b66;
  --loop:#4e6286;
  --font-display:"Sora",-apple-system,"Segoe UI",sans-serif;
  --font-body:"IBM Plex Sans",-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --av:42px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--font-body);font-variant-numeric:tabular-nums;display:flex;flex-direction:column;height:100dvh;overflow:hidden}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
button{font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:6px;padding:2px 9px;cursor:pointer}
button:hover{border-color:var(--ink-2)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:500}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{font:12.5px/1.4 var(--font-mono);color:var(--ink-2)}
input,select,textarea{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;width:100%;min-width:0}
input[type=checkbox]{width:auto}
.muted{color:var(--ink-2)}.small{font-size:12px}.dim{color:var(--ink-3)}
.av{width:var(--av);height:var(--av);border-radius:50%;object-fit:cover;background:var(--bg);box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--c);flex:none;display:inline-grid;place-items:center;font-size:20px}
body[data-view="gate"] #dash{display:none}
body[data-view="dash"] #gate{display:none}

/* header strip: never scrolls */
.top{flex:none;display:flex;align-items:center;gap:18px;padding:10px 22px;border-bottom:1px solid var(--line);background:var(--surface);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px;font:300 18px/1 var(--font-display)}
.brand svg{width:24px;height:24px}
.org{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.org b{font:600 15px/1.2 var(--font-display)}
.org .meta{color:var(--ink-2);font-size:12px;margin-left:8px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;align-items:center;flex:none}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--ink-2);background:var(--bg)}
.pill b{color:var(--ink);font-weight:500}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--ink-3);flex:none}
.pill.good .dot{background:var(--good)}.pill.run .dot{background:var(--accent)}.pill.warn .dot{background:var(--warn)}.pill.bad .dot{background:var(--bad)}
.pill.warn{border-color:var(--warn)}.pill.bad{border-color:var(--bad);color:var(--bad)}
.pill button{padding:0 7px;font-size:11px;border-radius:999px}
.pill.click{cursor:pointer}.pill.click:hover{border-color:var(--ink-2)}
#conn{font-size:11px;color:var(--ink-3)}#conn.off{color:var(--warn)}

/* the gate: one centered column that scrolls */
#gate{flex:1;min-height:0;overflow:auto}
.wrap{max-width:880px;margin:0 auto;padding:36px 22px 80px}
h1{font:300 30px/1.2 var(--font-display);margin:0 0 6px;text-wrap:balance}
.lede{color:var(--ink-2);margin:0 0 24px;max-width:62ch}
.tiles{display:flex;gap:6px;margin-bottom:24px}
.tiles div{flex:1;padding:8px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--line);font-size:12.5px;color:var(--ink-3)}
.tiles div b{display:block;color:var(--ink);font-weight:500}
.tiles div.done{border-color:color-mix(in oklab,var(--good) 50%,var(--line))}.tiles div.done b::before{content:"✓ ";color:var(--good)}
.tiles div.on{border-color:var(--warn)}.tiles div.on b::before{content:"! ";color:var(--warn)}
.tiles div.todo b::before{content:"· ";color:var(--ink-3)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.panel h2{font:400 13px/1 var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin:0 0 12px;display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.panel h2 .sub{font:12px/1.3 var(--font-body);letter-spacing:0;text-transform:none;color:var(--ink-3)}
.panel p{margin:0 0 10px;color:var(--ink-2)}
.panel p.small{font-size:12.5px;color:var(--ink-3)}
.two{display:grid;grid-template-columns:1fr 1.7fr;gap:14px}
.choice{border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:grid;gap:10px;align-content:start}
.choice h3{margin:0;font:600 14px/1.3 var(--font-display)}
label.f{display:grid;gap:4px;font-size:12px;color:var(--ink-3)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row .sep{color:var(--ink-3)}
.row label{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--ink-2);white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer;display:grid;gap:3px;font-size:12.5px;color:var(--ink-2);align-content:start}
.card.on{border-color:var(--accent);background:var(--surface-2)}
.card b{color:var(--ink);font-weight:500;font-size:13.5px}
.card .n{color:var(--ink-3);font-size:12px}
.card input[type=text]{margin-top:4px}
.crew{display:flex;flex-wrap:wrap;gap:10px 16px;padding:12px 14px;border:1px dashed var(--line);border-radius:10px}
.crew span{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink)}
.crew .av{--av:36px;font-size:18px;box-shadow:0 0 0 2px var(--c)}
.crew i{font-style:normal;color:var(--c);font-size:11.5px}
.crew .empty{color:var(--ink-3)}
.pick{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.pick label{border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:grid;grid-template-columns:auto auto 1fr;gap:4px 10px;align-items:center;font-size:12.5px;color:var(--ink-2);cursor:pointer}
.pick label.on{border-color:var(--accent)}
.pick label .av{--av:32px;font-size:16px;box-shadow:0 0 0 2px var(--c)}
.pick label b{color:var(--ink);font-weight:500}
.pick label .d{grid-column:1/4;color:var(--ink-3);font-size:12px}
.list{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.check{display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:baseline;padding:9px 16px;border-top:1px solid var(--line);font-size:13.5px}
.check:first-child{border-top:none}
.check .mark{font-weight:700;text-align:center}
.check.pass .mark{color:var(--good)}.check.fail .mark{color:var(--bad)}.check.warn .mark{color:var(--warn)}.check.skip .mark{color:var(--ink-3)}
.check .detail{color:var(--ink-3);font-size:12.5px;margin-left:8px;overflow-wrap:anywhere}
.check.skip{color:var(--ink-3)}
.check .at{font:12px/1.4 var(--font-mono);color:var(--ink-3)}
.fixbox{grid-column:2/4;margin:4px 0 6px;padding:14px 16px;border:1px solid var(--warn);border-radius:10px;background:var(--surface-2)}
.fixbox p{margin:0 0 8px;color:var(--ink-2)}
.cmd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.cmd code{overflow-wrap:anywhere}
.cmd input{width:180px}
.device{padding:16px;border-radius:10px;background:var(--bg);text-align:center;border:1px solid var(--line);margin-top:8px}
.device .code{font:700 34px/1.2 var(--font-mono);letter-spacing:.1em;margin:4px 0 12px;user-select:all;cursor:pointer}
.device .note{color:var(--ink-3);font-size:12.5px;margin-top:8px}
.out{font:12px/1.5 var(--font-mono);color:var(--ink-2);white-space:pre-wrap;margin-top:12px;max-height:160px;overflow:auto;border-top:1px dashed var(--line);padding-top:8px}
.banner{display:flex;align-items:center;gap:14px;padding:14px 18px;border:1px solid var(--good);border-radius:12px;background:color-mix(in oklab,var(--good) 10%,var(--surface));margin-bottom:16px}
.banner .mark{font-size:22px;color:var(--good)}
.banner b{font:600 16px/1.3 var(--font-display);display:block}
.banner span{color:var(--ink-2)}
.banner .go{margin-left:auto}
.foot{margin-top:18px;color:var(--ink-3);font-size:12.5px;max-width:64ch}
.bar-actions{display:flex;gap:10px;align-items:center;margin:0 0 16px;font-size:12.5px;color:var(--ink-3)}

/* the dashboard: three columns that share the width and scroll inside */
.shell{flex:1;min-height:0;display:grid;grid-template-columns:minmax(250px,17fr) minmax(0,53fr) minmax(380px,30fr);gap:14px;padding:14px 16px}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
section>h2{flex:none;font:400 13px/1 var(--font-display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin:0;padding:14px 18px 11px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:10px;justify-content:space-between}
section>h2 .sub{font:12px/1.3 var(--font-body);letter-spacing:0;text-transform:none;color:var(--ink-3);text-align:right}
section>.body{flex:1;min-height:0;overflow:auto;padding:12px 18px 16px;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.col.right{display:grid;grid-template-rows:1fr 1fr;gap:14px;min-height:0;min-width:0}
.empty{color:var(--ink-3);font-size:13px;padding:6px 0}

/* organization: the Director on top, groups below, the front desk apart */
.orgchart .body{padding-left:10px;padding-right:10px}
.conn{width:2px;height:16px;background:var(--line);margin:0 0 0 calc(8px + var(--av) / 2)}
.group{margin-top:10px}
.group h3{display:flex;align-items:center;gap:8px;font:500 10.5px/1 var(--font-display);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:0 0 4px;padding:0 8px}
.group h3::after{content:"";flex:1;height:1px;background:var(--line)}
.group h3 i{width:8px;height:8px;border-radius:2px;background:var(--gc);font-style:normal}
.agent{--c:var(--ink-3);position:relative;display:grid;grid-template-columns:var(--av) 1fr;gap:1px 12px;align-items:center;padding:8px 8px;border-radius:10px;border:1px solid transparent;cursor:pointer}
.agent:hover,.agent:focus-visible,.agent.is-open{background:var(--surface-2);border-color:var(--line)}
.agent .av{grid-row:1/span 2;position:relative}
.agent.is-idle .av{box-shadow:0 0 0 2px var(--surface),0 0 0 3px color-mix(in oklab,var(--c) 50%,transparent)}
.agent.is-active .av{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--c)}
.agent.is-active .ring{position:absolute;left:5px;top:5px;width:calc(var(--av) + 8px);height:calc(var(--av) + 8px);border-radius:50%;border:2px solid var(--c);animation:pulse 1.8s ease-out infinite;pointer-events:none}
.agent.is-remote .av{box-shadow:0 0 0 2px var(--surface);outline:2px dashed var(--c);outline-offset:2px}
@keyframes pulse{0%{transform:scale(.9);opacity:.9}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion:reduce){.agent.is-active .ring{animation:none;opacity:.6}}
.agent .name{font:600 14px/1.2 var(--font-display);color:var(--ink)}
.agent .name span{font:400 12px/1.3 var(--font-body);color:var(--c);margin-left:6px;letter-spacing:.02em;display:inline-block}
.agent .now{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent.is-active .now,.agent.is-remote .now{color:var(--ink-2)}
.apart{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
.apart p{margin:6px 0 0 8px;color:var(--ink-3);font-size:11.5px}

/* the description: one card to the right of the agent, over the activity; it never moves the other agents */
#pop{position:fixed;z-index:50;width:340px;max-width:calc(100vw - 32px);padding:12px 14px;border:1px solid var(--line);border-left:4px solid var(--c,var(--line));border-radius:10px;background:var(--bg);color:var(--ink-2);font-size:12.5px;box-shadow:0 12px 36px rgba(0,0,0,.5);display:none}
#pop.show{display:block}
#pop .who{display:flex;align-items:flex-end;gap:14px;margin-bottom:10px}
#pop .who .av{--av:128px;border-radius:14px;font-size:64px;box-shadow:0 0 0 2px var(--c)}
#pop .who b{font:600 19px/1.2 var(--font-display);color:var(--ink);display:block;margin-bottom:3px}
#pop .who span{color:var(--c);font-size:12px;letter-spacing:.02em}
#pop p{margin:0 0 8px;color:var(--ink);line-height:1.45}
#pop dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0}
#pop dt{color:var(--ink-3)}#pop dd{margin:0;color:var(--ink-2);overflow-wrap:anywhere}
#pop .foot{margin-top:9px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;display:flex;justify-content:space-between;gap:10px}

/* activity: the widest column */
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.filters button{font-size:12px;padding:2px 9px;border-radius:999px;color:var(--ink-2)}
.filters button.on{color:var(--ink);border-color:var(--ink-2);background:var(--surface-2)}
.filters button i{font-style:normal;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--c);margin-right:6px}
h3.band{font:500 11px/1 var(--font-display);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:18px 0 8px;display:flex;align-items:center;gap:10px}
h3.band::after{content:"";flex:1;height:1px;background:var(--line)}
h3.band:first-child{margin-top:0}
.live{--c:var(--ink-3);display:grid;grid-template-columns:56px 1fr;gap:4px 14px;padding:14px 16px;border:1px solid var(--line);border-left:4px solid var(--c);border-radius:12px;background:var(--surface-2);margin-bottom:10px}
.live .av{--av:56px;grid-row:1/span 6;box-shadow:0 0 0 2px var(--surface-2),0 0 0 4px var(--c);font-size:26px}
.live.remote .av{box-shadow:0 0 0 2px var(--surface-2);outline:2px dashed var(--c);outline-offset:2px;opacity:.9}
.live .head{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.live .head b{font:600 16px/1.2 var(--font-display)}
.live .head .role{color:var(--c);font-size:12.5px;letter-spacing:.02em}
.live .head .task{color:var(--ink)}
.live .head .where{margin-left:auto;font-size:12px;color:var(--ink-3)}
.live .bar{height:6px;border-radius:3px;background:var(--bg);overflow:hidden;margin-top:4px}
.live .bar i{display:block;height:100%;background:var(--c);border-radius:3px}
.live .nums{font-size:12.5px;color:var(--ink-2)}
.live .nums b{color:var(--ink);font-weight:500}
.live .what{font-size:13.5px;color:var(--ink)}
.live .what .verb{color:var(--ink-2)}
.live .said{font-size:13px;color:var(--ink-2);font-style:italic;border-left:2px solid var(--line);padding-left:10px;margin-top:2px}
.live.loop{--c:var(--loop)}
.steps{display:flex;gap:4px;margin-top:4px}
.steps i{flex:1;height:6px;border-radius:3px;background:var(--bg)}
.steps i.done{background:var(--good)}.steps i.on{background:var(--accent)}.steps i.failed{background:var(--bad)}
.ev{--c:var(--ink-3);display:grid;grid-template-columns:var(--av) 1fr;gap:2px 14px;padding:10px 6px;border-top:1px solid var(--line);align-items:start}
.ev .av{margin-top:2px}
.ev .glyph{box-shadow:0 0 0 2px var(--line);color:var(--ink-3);font-size:15px}
.ev .head{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;font-size:13px}
.ev .head b{font:600 14px/1.3 var(--font-display);color:var(--ink)}
.ev .head .role{color:var(--c)}
.ev .head .task{color:var(--ink-3)}
.ev .head time{margin-left:auto;font:12px/1.4 var(--font-mono);color:var(--ink-3)}
.ev .what{font-size:14px;color:var(--ink);overflow-wrap:anywhere}
.ev .what .verb{color:var(--ink-2)}
.ev .what code{font-size:13px;color:var(--ink)}
.ev.warn .what{color:var(--warn)}
.ev.error .what{color:var(--bad)}
.ev.needs .what::after{content:" · needs you";color:var(--warn);font-size:12px}
.ev .said{font-size:13.5px;color:var(--ink-2);font-style:italic;border-left:2px solid color-mix(in oklab,var(--c) 60%,transparent);padding-left:10px;margin-top:3px;white-space:pre-wrap}
.ev .fold{display:inline-block;font-size:12px;color:var(--ink-3);border:1px solid var(--line);border-radius:4px;padding:0 7px;margin-top:4px;cursor:pointer}
.ev .fold:hover{color:var(--ink-2)}
.ev .more{margin:4px 0 0;padding:0 0 0 14px;color:var(--ink-2);font-size:13px}
.ev .more li code{color:var(--ink-2)}

/* work */
.tgroup{margin-bottom:12px}
.tgroup h3{font:500 11px/1 var(--font-display);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:0 0 4px}
.work .task{display:grid;grid-template-columns:76px 1fr auto;gap:10px;align-items:center;padding:8px 6px;border-top:1px solid var(--line)}
.tgroup .task:first-of-type{border-top:none}
.status{font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--line);border-radius:4px;padding:1px 6px;text-align:center;color:var(--ink-2)}
.status.review,.status.approved{border-color:var(--warn);color:var(--warn)}
.status.failed{border-color:var(--bad);color:var(--bad)}
.status.running,.status.executing{border-color:var(--ink-2);color:var(--ink)}
.status.inbox{border-style:dashed}
.work .task .title{color:var(--ink);font-size:13.5px}
.work .task .title a{color:var(--ink-3);font-family:var(--font-mono);font-size:12px;margin-right:6px}
.work .task .where{font-size:11.5px;color:var(--ink-3)}
.chip{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;color:var(--ink-2);justify-self:end}
.chip .av{box-shadow:0 0 0 2px var(--c)}
.needs{border-left:3px solid var(--warn);padding-left:10px;margin-left:-13px}

/* front desk: the messages scroll, the input stays at the bottom */
.desk .body{display:flex;flex-direction:column;gap:8px;padding-top:10px}
.desk .body>:first-child{margin-top:auto}
.msg{padding:8px 11px;border-radius:10px;max-width:92%;font-size:13.5px;white-space:pre-wrap}
.msg.you{align-self:flex-end;background:color-mix(in oklab,var(--accent) 22%,var(--surface-2))}
.msg.desk{align-self:flex-start;background:var(--surface-2);display:grid;grid-template-columns:24px 1fr;gap:8px}
.msg.desk .av{--av:24px;font-size:13px;box-shadow:none;margin-top:2px}
.msg.note{align-self:center;color:var(--ink-3);font-size:12px;background:none}
.msg .meta{font-size:11px;color:var(--ink-3);margin-top:4px}
.chatbox{flex:none;display:flex;gap:6px;padding:10px 14px 14px;border-top:1px solid var(--line)}
.chatbox input{border-radius:8px;padding:7px 10px}

/* under about 1100 px the columns stack and the page scrolls as a whole */
@media (max-width:1100px){
  body{height:auto;overflow:auto}
  .shell{display:flex;flex-direction:column;height:auto}
  section,section>.body{overflow:visible}
  .col.right{display:flex;flex-direction:column}
  .desk .body{max-height:60vh;overflow:auto}
  .pills{margin-left:0}
}
@media (max-width:760px){.two,.cards,.pick{grid-template-columns:1fr}.tiles{flex-wrap:wrap}.tiles div{flex:1 1 40%}}
</style>
</head>
<body data-view="gate">
<header class="top">
  <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" style="stroke:var(--ink)" stroke-width="1.6"/><path d="M7 12h10" style="stroke:var(--accent)" stroke-width="2.4" stroke-linecap="round"/><circle cx="17" cy="12" r="1.8" style="fill:var(--accent)"/></svg><span>dashing-agent</span></div>
  <div class="org" id="org"></div>
  <div class="pills" id="pills"></div>
</header>

<main id="gate"><div class="wrap" id="gateBody"><h1>Checking this laptop…</h1></div></main>

<div class="shell" id="dash">
  <section class="orgchart">
    <h2>Organization <span class="sub" id="orgSub"></span></h2>
    <div class="body" id="chart"></div>
  </section>
  <section class="activity">
    <h2>Activity <span class="sub" id="actSub">this laptop in full · other laptops as the board shows them</span></h2>
    <div class="body" id="actBody"><div class="filters" id="filters"></div><div id="feed"></div></div>
  </section>
  <div class="col right">
    <section class="work">
      <h2>Work <span class="sub" id="workSub"></span></h2>
      <div class="body" id="work"></div>
    </section>
    <section class="desk">
      <h2>Front desk <span class="sub" id="deskSub"></span></h2>
      <div class="body" id="chat"></div>
      <div class="chatbox"><input id="c-text" placeholder="Ask about the board, or ask for work to be done" autocomplete="off"><button class="primary" id="c-send">Send</button></div>
    </section>
  </div>
</div>

<div id="pop" role="tooltip"></div>
<script>
'use strict';
// ---------- helpers ----------
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var pad = function (n) { return (n < 10 ? '0' : '') + n; };
var hm = function (iso) { if (!iso) return ''; var d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
var hms = function (iso) { if (!iso) return ''; var d = new Date(iso); return hm(iso) + ':' + pad(d.getSeconds()); };
var sameDay = function (iso) { var d = new Date(iso), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };
var when = function (iso) { return iso ? (sameDay(iso) ? hms(iso) : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm(iso)) : ''; };
var ago = function (iso) {
  if (!iso) return '';
  var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return (s / 3600).toFixed(1).replace(/\.0$/, '') + ' h';
  return Math.round(s / 86400) + ' d';
};
var cap = function (s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };
var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
function post(url, body) { return fetch(url, { method: 'POST', headers: { 'x-dashing': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function postJson(url, body) { return post(url, body).then(function (r) { return r.json().catch(function () { return {}; }); }); }
var htmlCache = {};
function setHtml(el, html) { if (!el) return; if (htmlCache[el.id] === html) return; htmlCache[el.id] = html; el.innerHTML = html; }
var PALETTE = ['#3987e5', '#e8702f', '#199e70', '#9085e9', '#d55181', '#f0c252', '#5fd3a6', '#f29ab8', '#6a5bd0', '#ffb285', '#44c07f', '#b2431a'];
var LOOPS = { 'agent loop': '⟳', 'mechanical loop': '⚙', 'pre-flight': '✓', page: '☞' };

// ---------- state ----------
var S = null;
var byName = {};
var manualGate = false;
var shownOk = null;
var passTimer = null;
var filter = 'all';
var unfolded = {};
var connected = false;

function agentsOf(s) {
  byName = {};
  if (!s.org) return [];
  s.org.agents.forEach(function (a, i) {
    a.c = a.color || PALETTE[i % PALETTE.length];
    byName[a.name] = a;
  });
  return s.org.agents;
}
function avatar(a, cls) {
  var c = (a && a.c) || 'var(--ink-3)';
  if (a && a.avatarUrl) return '<img class="av ' + (cls || '') + '" src="' + esc(a.avatarUrl) + '" alt="" style="--c:' + c + '">';
  return '<span class="av ' + (cls || '') + '" style="--c:' + c + '">' + esc(a && a.avatar ? a.avatar : (a ? cap(a.name).charAt(0) : '·')) + '</span>';
}
function glyph(who) { return '<span class="av glyph">' + (LOOPS[who] || '·') + '</span>'; }
function isDesk(a) { return !!a && (a.role.trim().toLowerCase() === 'front desk' || a.name === 'front-desk'); }
function taskLink(s, n) {
  var t = (s.tasks || []).find(function (x) { return x.number === n; });
  return t ? '<a href="' + esc(t.url) + '" target="_blank">#' + n + '</a>' : '#' + n;
}
function leaseOf(s, name) { return (s.leases || []).find(function (l) { return l.name === name && Date.parse(l.until) > Date.now(); }); }
function runOf(s, id) { return (s.runs || []).find(function (r) { return r.id === id; }); }
function runFor(s, agent) { return (s.runs || []).find(function (r) { return r.who === agent && r.kind === 'agent'; }); }
function remoteRuns(s) {
  var out = [];
  (s.leases || []).forEach(function (l) {
    if (l.mine || !/^task-\d+$/.test(l.name) || Date.parse(l.until) < Date.now()) return;
    var n = Number(l.name.slice(5));
    var t = (s.tasks || []).find(function (x) { return x.number === n; });
    if (!t) return;
    out.push({ lease: l, task: t, agent: t.agent ? byName[t.agent] : null, mechanical: t.status === 'Executing' || t.status === 'Approved' });
  });
  return out;
}
function lastEvent(s, test) {
  for (var i = s.events.length - 1; i >= 0; i--) if (test(s.events[i])) return s.events[i];
  return null;
}

// ---------- which view ----------
function isReady(s) { return !!(s.preflight && s.preflight.ok && s.org && Object.keys(s.loops || {}).length); }
function view(s) {
  var ok = isReady(s);
  if (manualGate) return 'gate';
  if (!ok) { shownOk = false; return 'gate'; }
  if (shownOk === null || shownOk === true) { shownOk = true; return 'dash'; }
  if (!passTimer) passTimer = setTimeout(function () { shownOk = true; passTimer = null; render(S); }, 3000);
  return 'gate';
}

// ---------- header ----------
function renderHeader(s, v) {
  var n = s.node;
  var meta = [esc(n.id), esc(n.folder || 'no organization folder yet')];
  if (s.repo) meta.push('<a href="' + esc(s.repo.url) + '" target="_blank">' + esc(s.repo.owner + '/' + s.repo.name) + '</a>');
  if (s.repo && s.repo.project) meta.push('<a href="' + esc(s.repo.url.replace(/\/[^/]+$/, '')) + '/projects/' + s.repo.project + '" target="_blank">project #' + s.repo.project + '</a>');
  setHtml($('org'), '<b>' + esc(s.org ? s.org.name : 'no organization yet') + '</b><span class="meta">' + meta.join(' · ') + '</span>');
  var p = s.preflight;
  var pills = [];
  if (!p) pills.push('<span class="pill"><span class="dot"></span>checking…</span>');
  else if (p.ok) pills.push('<span class="pill good click" data-act="gate" title="the checks"><span class="dot"></span><b>ready</b> · ' + p.checks.length + ' checks</span>');
  else {
    var fails = p.checks.filter(function (c) { return c.status === 'fail'; }).length;
    pills.push('<span class="pill warn click" data-act="gate"><span class="dot"></span>' + (p.needsOrganization ? 'first run · sign in, then an organization' : 'getting ready · ' + plural(fails, 'check fails', 'checks fail')) + '</span>');
  }
  if (s.org && s.org.killSwitch) pills.push('<span class="pill bad"><span class="dot"></span>kill switch on · nothing runs</span>');
  if (v === 'dash') {
    var d = leaseOf(s, 'director');
    var director = s.org ? byName[s.org.director] : null;
    var dc = director ? director.c : 'var(--ink-3)';
    pills.push('<span class="pill"><span class="dot" style="background:' + dc + '"></span>Director: <b>' + (d ? (d.mine ? 'this laptop' : esc(d.holder)) : 'no laptop yet') + '</b>' + (d ? ' until ' + hm(d.until) : '') + '</span>');
    Object.values(s.loops || {}).forEach(function (l) {
      var cls = l.status === 'running' ? 'run' : l.status === 'idle' ? 'good' : l.status === 'waiting' || l.status === 'paused' ? 'warn' : '';
      var word = l.status === 'running' ? (l.name === 'mechanical' ? 'executing' : 'running') : l.status;
      var btn = l.status === 'paused' ? '<button data-loop="' + l.name + '" data-do="resume">resume</button>' : l.status === 'stopped' ? '' : '<button data-loop="' + l.name + '" data-do="pause">pause</button>';
      pills.push('<span class="pill ' + cls + '" title="' + esc(l.ticks + ' ticks' + (l.lastTickAt ? ', last ' + hms(l.lastTickAt) : '') + (l.lastError ? ' · ' + l.lastError : '')) + '"><span class="dot"></span>' + (l.name === 'agent' ? 'agent loop' : 'mechanical') + ' <b>' + esc(word) + '</b> ' + btn + '</span>');
    });
  }
  pills.push('<span id="conn" class="' + (connected ? '' : 'off') + '">' + (connected ? 'live' : 'reconnecting…') + '</span>');
  setHtml($('pills'), pills.join(''));
}

// ---------- the gate ----------
var GROUPS = [
  { title: 'This laptop', ids: ['node', 'git', 'gh', 'claude'], note: 'Node, git, the GitHub CLI, Claude' },
  { title: 'GitHub', ids: ['gh-auth', 'gh-scopes', 'remote-access'], note: 'signed in, token scopes, access' },
  { title: 'The organization', ids: ['folder', 'git-repo', 'remote', 'git-name', 'git-email', 'upstream', 'org', 'kill', 'project'], note: 'the folder, the files, the Project' },
  { title: 'Leases', ids: ['leases'], note: 'the namespace on origin' },
];
function tileState(checks, ids) {
  var mine = checks.filter(function (c) { return ids.indexOf(c.id) >= 0; });
  if (!mine.length) return 'todo';
  if (mine.some(function (c) { return c.status === 'fail'; })) return 'on';
  if (mine.every(function (c) { return c.status === 'skip'; })) return 'todo';
  return 'done';
}
function fixUi(s, c) {
  var f = s.fix;
  if (f && f.id === c.id) {
    var h = '<div class="fixbox"><p><b>' + (f.running ? 'Running' : f.exitCode === 0 ? 'Done' : 'Failed') + ':</b> ' + esc(c.fix ? c.fix.description : c.title) + '</p>';
    h += '<div class="cmd"><code>' + esc(f.command.join(' ')) + '</code>' + (f.running ? '<button data-act="cancel-fix">cancel</button>' : '') + '</div>';
    if (f.device && f.running) h += '<div class="device"><div>Your one-time code for GitHub</div><div class="code" data-copy="' + esc(f.device.code) + '" data-url="' + esc(f.device.url) + '">' + esc(f.device.code) + '</div><button class="primary" data-copy="' + esc(f.device.code) + '" data-url="' + esc(f.device.url) + '">copy the code and open GitHub</button><div class="note">Paste it at <a href="' + esc(f.device.url) + '" target="_blank">' + esc(f.device.url.replace(/^https?:\/\//, '')) + '</a>, approve, and come back. This page updates by itself and re-checks when gh is done.</div></div>';
    if (f.lines.length) h += '<div class="out">' + f.lines.map(esc).join('\n') + '</div>';
    return h + '</div>';
  }
  if (!c.fix || (c.status !== 'fail' && c.status !== 'warn')) return '';
  var fx = c.fix;
  var h2 = '<div class="fixbox"><p>' + esc(fx.description) + '</p>';
  if (!fx.command) return h2 + '</div>';
  var cmd = fx.command.join(' ');
  if (fx.terminal) return h2 + '<div class="cmd"><code>' + esc(cmd) + '</code><span class="dim">run it in your shell, then re-check</span></div></div>';
  h2 += '<div class="cmd"><code>' + esc(cmd) + '</code></div><div class="cmd">';
  fx.placeholders.forEach(function (k) { h2 += '<input data-fix="' + esc(c.id) + '" data-key="' + esc(k) + '" placeholder="' + esc(k) + '">'; });
  var busy = s.fix && s.fix.running;
  h2 += '<button class="primary" data-run-fix="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>' + (fx.placeholders.length ? 'fill in and fix' : 'fix it') + '</button></div></div>';
  return h2;
}
function checkList(s, skipIds) {
  var p = s.preflight;
  var marks = { pass: '✓', fail: '✗', warn: '!', skip: '–' };
  return '<div class="list">' + p.checks.map(function (c) {
    return '<div class="check ' + c.status + '"><span class="mark">' + marks[c.status] + '</span><span>' + esc(c.title) + ' <span class="detail">' + esc(c.detail) + '</span></span><span class="at">' + (c.status === 'skip' ? '' : hms(p.at)) + '</span>' + (skipIds.indexOf(c.id) >= 0 ? '' : fixUi(s, c)) + '</div>';
  }).join('') + '</div>';
}
function renderGate(s) {
  var p = s.preflight;
  var body = $('gateBody');
  if (!p) { setHtml(body, '<h1>Checking this laptop…</h1><p class="lede">Node, git, the GitHub CLI, the sign-in, the folder. A few seconds.</p>'); return; }
  var ok = isReady(s);
  var auth = p.checks.find(function (c) { return c.id === 'gh-auth'; });
  var authFails = !!auth && auth.status === 'fail';
  var first = !ok && (p.needsOrganization || authFails);
  var h = '';
  var tiles = '<div class="tiles">' + GROUPS.map(function (g) { return '<div class="' + (ok ? 'done' : tileState(p.checks, g.ids)) + '"><b>' + g.title + '</b>' + g.note + '</div>'; }).join('') + '</div>';
  var skip = [];
  if (ok) {
    h += '<h1>Everything is ready to run</h1><p class="lede">All ' + p.checks.length + ' checks pass on this laptop. The loops run with the dashboard.</p>';
    h += '<div class="banner"><span class="mark">✓</span><div><b>' + (manualGate ? 'The dashboard is running' : 'The dashboard opens in a moment') + '</b><span>The page comes back here by itself if a check fails later.</span></div><span class="go"><button class="primary" data-act="dash">' + (manualGate ? 'back to the dashboard' : 'open it now') + '</button></span></div>';
    h += tiles;
  } else if (first) {
    h += '<h1>Welcome. Let us get this laptop ready.</h1><p class="lede">Three things, in order: sign in to GitHub, pick or build an organization, run the checks. The page does each one for you and shows every command it runs. Nothing is typed into the terminal.</p>' + tiles;
    if (authFails) {
      skip.push('gh-auth');
      h += '<section class="panel"><h2>1 · Sign in to GitHub <span class="sub">' + esc(auth.detail) + '</span></h2><p>GitHub signs you in with a one-time code. The page runs the command below; gh keeps the token, this tool never sees it.</p>' + fixUi(s, auth) + '</section>';
    } else {
      h += '<section class="panel"><h2>1 · Sign in to GitHub <span class="sub">done</span></h2><p>' + esc(auth ? auth.detail : 'signed in') + '.</p></section>';
    }
    if (p.needsOrganization) h += '<section class="panel" id="orgPanel"><h2>2 · The organization <span class="sub">' + (authFails ? 'opens when step 1 is done' : 'pick a folder or build one') + '</span></h2><p>An organization is a GitHub repository with <code>dashing.yaml</code> at its root, the agents and actions in folders it names. Point the page at one you have, or build one here.</p><div id="builder"></div></section>';
    h += '<div class="bar-actions"><span>The checks, cheapest first.</span><button data-act="recheck">re-check now</button></div>';
  } else {
    h += '<h1>Getting ready</h1><p class="lede">This page runs every check in order, cheapest first, and offers the fix for each one that fails. When all of them pass it becomes the dashboard by itself.</p>' + tiles;
    h += '<div class="bar-actions"><span>' + (s.fix && s.fix.running ? 'a fix is running' : 'the page re-checks every 30 seconds while something fails') + '</span><button data-act="recheck">re-check now</button></div>';
  }
  h += checkList(s, skip);
  h += '<p class="foot">This page is the gate. It shows at start, turns into the dashboard when every check passes, and comes back whenever a check fails later: a token expires, the kill switch appears, the organization files stop loading.</p>';
  if (htmlCache.gateBody === h) { if ($('builder')) renderBuilder(s); return; }
  var inputs = {};
  body.querySelectorAll('input[data-fix]').forEach(function (i) { inputs[i.dataset.fix + '/' + i.dataset.key] = i.value; });
  var keep = $('builder');
  if (keep && !keep.firstChild) keep = null;
  setHtml(body, h);
  body.querySelectorAll('input[data-fix]').forEach(function (i) { var v = inputs[i.dataset.fix + '/' + i.dataset.key]; if (v) i.value = v; });
  var slot = $('builder');
  if (slot && keep) slot.replaceWith(keep);
  if ($('builder')) renderBuilder(s);
}

// ---------- the builder (inside the gate) ----------
var builderBuilt = false;
var pickedTemplate = '';
var pickMode = 'template';
var lastOwners = '';
function libColor(a, i) { return a.color || PALETTE[i % PALETTE.length]; }
function ownerOptions(s) {
  var list = s.owners.length ? s.owners : [s.node.user];
  return list.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + (o === s.node.user ? ' (your account)' : '') + '</option>'; }).join('');
}
function renderBuilder(s) {
  var slot = $('builder');
  if (!slot) return;
  if (s.fix && s.fix.id === 'build') {
    var f = s.fix;
    builderBuilt = false;
    setHtml(slot, '<div class="fixbox"><p><b>' + (f.running ? 'Building' : f.exitCode === 0 ? 'Built' : 'The build failed') + '</b></p>' + (f.lines.length ? '<div class="out">' + f.lines.map(esc).join('\n') + '</div>' : '') + (f.running ? '' : '<div class="cmd" style="margin-top:10px"><button data-act="rebuild">back to the form</button></div>') + '</div>');
    return;
  }
  if (builderBuilt && slot.querySelector('#b-name')) { syncOwners(s); return; }
  builderBuilt = true;
  delete htmlCache.builder;
  var base = (s.node.folder || '').split('/').filter(Boolean).pop() || 'my-org';
  var lib = s.library || [];
  var h = '<div class="two"><div class="choice"><h3>I have one</h3><label class="f">Folder<input id="u-folder" value="' + esc(s.node.folder || '~/git/') + '"></label><div><button data-act="use-folder">Check it</button></div><p class="small">Any folder with <code>dashing.yaml</code>, cloned from GitHub. The checks run on it right away.</p></div>';
  h += '<div class="choice"><h3>Build a new one</h3>';
  h += '<label class="f">Name<input id="b-name" value="' + esc(base) + '"></label>';
  h += '<label class="f">Folder<input id="b-folder" value="' + esc(s.node.folder || '~/git/' + base) + '"></label>';
  h += '<label class="f">GitHub repository<div class="row"><select id="b-owner" style="width:170px">' + ownerOptions(s) + '</select><span class="sep">/</span><input id="b-repo" style="flex:1" value="' + esc(base) + '" placeholder="leave empty to add the repository later"><label><input type="checkbox" id="b-private" checked> private</label></div></label>';
  h += '<div class="small dim">Start from</div><div class="cards" id="startFrom">';
  var templates = (s.templates || []).slice().sort(function (a, b) { return b.agents.length - a.agents.length || a.name.localeCompare(b.name); });
  h += templates.map(function (tp) { return '<div class="card" data-template="' + esc(tp.name) + '"><b>' + esc((tp.avatar ? tp.avatar + ' ' : '') + tp.title) + '</b><span>' + esc(tp.description) + '</span><span class="n">' + plural(tp.agents.length, 'agent') + ' · ' + esc(cap(tp.director)) + ' directs</span></div>'; }).join('');
  h += '<div class="card" data-mode="pick"><b>Pick agents yourself</b><span>Any set from the library of ' + lib.length + '.</span><span class="n">you choose the Director</span></div>';
  h += '<div class="card" data-mode="from"><b>Copy another organization&#39;s agents</b><span>A folder or owner/repo gh can reach; avatars come along.</span><input type="text" id="b-from" placeholder="owner/repo or a folder"></div>';
  h += '</div>';
  h += '<label class="f">Director<select id="b-director">' + lib.map(function (a) { return '<option value="' + esc(a.name) + '"' + (a.required ? ' selected' : '') + '>' + esc(cap(a.name) + ' · ' + a.role) + '</option>'; }).join('') + '</select></label>';
  h += '<div class="crew" id="crew"></div>';
  h += '<div class="pick" id="pick" style="display:none">' + lib.map(function (a, i) { return '<label style="--c:' + libColor(a, i) + '"><input type="checkbox" class="b-agent" value="' + esc(a.name) + '">' + avatar({ name: a.name, avatar: a.avatar, avatarUrl: a.avatarUrl, c: libColor(a, i) }) + '<span><b>' + esc(cap(a.name)) + '</b> <span class="dim">' + esc(a.role) + (a.group ? ' · ' + esc(a.group) : '') + '</span></span><span class="d">' + esc(a.description) + '</span></label>'; }).join('') + '</div>';
  h += '<div><button class="primary" data-act="create">Create the repository and build the organization</button></div>';
  h += '<p class="small" id="b-note"></p>';
  h += '</div></div>';
  slot.innerHTML = h;
  var folderTouched = false, repoTouched = false;
  $('b-folder').addEventListener('input', function () { folderTouched = true; });
  $('b-repo').addEventListener('input', function () { repoTouched = true; });
  $('b-name').addEventListener('input', function (e) {
    var n = e.target.value.trim();
    if (!folderTouched) $('b-folder').value = '~/git/' + n;
    if (!repoTouched) $('b-repo').value = n;
    note();
  });
  $('b-director').addEventListener('change', function () { syncDirector(); crew(); });
  slot.querySelectorAll('.b-agent').forEach(function (i) { i.addEventListener('change', function () { i.closest('label').classList.toggle('on', i.checked); crew(); }); });
  slot.querySelectorAll('#startFrom .card').forEach(function (c) {
    c.addEventListener('click', function (e) {
      if (e.target.tagName === 'INPUT') { setMode('from'); return; }
      if (c.dataset.template) pickTemplate(c.dataset.template); else setMode(c.dataset.mode);
    });
  });
  $('b-from').addEventListener('input', function () { setMode('from'); });
  if (templates[0]) pickTemplate(templates[0].name); else setMode('pick');
  function note() {
    var repo = $('b-repo').value.trim() ? $('b-owner').value + '/' + $('b-repo').value.trim() : '';
    $('b-note').textContent = (repo ? 'Creates ' + repo + ' with its Project, ' : 'Without a repository: ') + 'writes dashing.yaml, the agents and the actions into ' + $('b-folder').value.trim() + ', ' + (repo ? 'pushes the first commit, ' : 'makes the first commit, ') + 'then runs the checks on the new folder.';
  }
  $('b-repo').addEventListener('input', note); $('b-owner').addEventListener('change', note); $('b-folder').addEventListener('input', note);
  note();
}
function setMode(mode) {
  pickMode = mode;
  if (mode !== 'template') pickedTemplate = '';
  document.querySelectorAll('#startFrom .card').forEach(function (c) { c.classList.toggle('on', mode === 'template' ? c.dataset.template === pickedTemplate : c.dataset.mode === mode); });
  $('pick').style.display = mode === 'pick' ? '' : 'none';
  if (mode === 'from') { document.querySelectorAll('.b-agent').forEach(function (i) { if (!i.disabled) { i.checked = false; i.closest('label').classList.remove('on'); } }); }
  crew();
}
function pickTemplate(name) {
  var tp = (S.templates || []).find(function (x) { return x.name === name; });
  if (!tp) return;
  pickedTemplate = name;
  document.querySelectorAll('.b-agent').forEach(function (i) { i.disabled = false; i.checked = tp.agents.indexOf(i.value) >= 0; i.closest('label').classList.toggle('on', i.checked); });
  var sel = $('b-director');
  if (Array.from(sel.options).some(function (o) { return o.value === tp.director; })) sel.value = tp.director;
  syncDirector();
  setMode('template');
}
function syncDirector() {
  var who = $('b-director').value;
  document.querySelectorAll('.b-agent').forEach(function (i) {
    if (i.value === who) { i.checked = true; i.disabled = true; i.closest('label').classList.add('on'); } else if (i.disabled) { i.disabled = false; }
  });
}
function chosenAgents() { return Array.from(document.querySelectorAll('.b-agent')).filter(function (i) { return i.checked; }).map(function (i) { return i.value; }); }
function crew() {
  var el = $('crew');
  if (!el) return;
  var names = chosenAgents();
  var lib = S.library || [];
  var h = names.map(function (n) { var i = lib.findIndex(function (a) { return a.name === n; }); var a = lib[i]; if (!a) return ''; var c = libColor(a, i); return '<span style="--c:' + c + '">' + avatar({ name: a.name, avatar: a.avatar, avatarUrl: a.avatarUrl, c: c }) + esc(cap(a.name)) + ' <i>' + esc(a.role) + '</i></span>'; }).join('');
  if (pickMode === 'from') h += '<span class="empty">+ the agents of ' + esc(($('b-from').value || 'the organization you name').trim()) + '</span>';
  el.innerHTML = h || '<span class="empty">no agents chosen yet</span>';
}
function syncOwners(s) {
  var key = s.owners.join(',');
  var sel = $('b-owner');
  if (!sel || key === lastOwners) return;
  lastOwners = key;
  var chosen = sel.value;
  sel.innerHTML = ownerOptions(s);
  if (Array.from(sel.options).some(function (o) { return o.value === chosen; })) sel.value = chosen;
}
function createOrg() {
  var v = function (id) { return ($(id).value || '').trim(); };
  var repo = v('b-repo') ? v('b-owner') + '/' + v('b-repo') : '';
  var body = { name: v('b-name'), folder: v('b-folder'), repo: repo, private: $('b-private').checked, director: v('b-director'), agents: chosenAgents(), template: pickedTemplate, from: pickMode === 'from' ? v('b-from') : '' };
  postJson('/api/org/create', body).then(function (j) { if (j.error) alert(j.error); });
}

// ---------- the dashboard ----------
function nowLine(s, a) {
  var r = runFor(s, a.name);
  if (r) return { cls: 'is-active', text: (r.task ? 'on #' + r.task + ' · ' : '') + (r.now || 'thinking') };
  var remote = remoteRuns(s).find(function (x) { return x.task.agent === a.name && !x.mechanical; });
  if (remote) return { cls: 'is-remote', text: 'on #' + remote.task.number + ' · running on ' + remote.lease.holder };
  var mine = (s.tasks || []).filter(function (t) { return t.agent === a.name; });
  var pick = function (st) { return mine.find(function (t) { return t.status === st; }); };
  var t;
  if ((t = pick('Running'))) return { cls: 'is-remote', text: 'on #' + t.number + ' · on another laptop' };
  if ((t = pick('Assigned'))) return { cls: 'is-idle', text: 'assigned #' + t.number + ' · waits for a free laptop' };
  if ((t = pick('Failed'))) return { cls: 'is-idle', text: '#' + t.number + ' failed · waits for a retry' };
  if ((t = pick('Review'))) return { cls: 'is-idle', text: '#' + t.number + ' in Review · waits for you' };
  if ((t = pick('Approved')) || (t = pick('Executing'))) return { cls: 'is-idle', text: '#' + t.number + ' · the mechanical loop runs the plan' };
  if (s.org && a.name === s.org.director) {
    var inbox = (s.tasks || []).filter(function (x) { return x.status === 'Inbox'; }).length;
    var last = lastEvent(s, function (e) { return e.who === a.name && (e.verb === 'finished' || e.verb === 'stopped'); });
    return { cls: 'is-idle', text: (inbox ? plural(inbox, 'task') + ' in the inbox' : 'inbox empty') + (last ? ' · last pass ' + hm(last.at) : '') };
  }
  if (isDesk(a)) {
    var filed = lastEvent(s, function (e) { return e.who === a.name && e.verb === 'filed'; });
    return { cls: 'is-idle', text: 'answers the chat on this page' + (filed ? ' · filed #' + filed.task + ' at ' + hm(filed.at) : '') };
  }
  var ev = lastEvent(s, function (e) { return e.who === a.name && e.verb !== 'said'; });
  return { cls: 'is-idle', text: ev ? ev.verb.replace(/:$/, '') + ' ' + (ev.task ? '#' + ev.task + ' ' : '') + (sameDay(ev.at) ? 'at ' + hm(ev.at) : when(ev.at)) : 'idle' };
}
function agentCard(s, a, lead) {
  var n = nowLine(s, a);
  return '<article class="agent ' + n.cls + (lead ? ' lead' : '') + '" style="--c:' + a.c + '" tabindex="0" data-agent="' + esc(a.name) + '">' + avatar(a) + (n.cls === 'is-active' ? '<span class="ring"></span>' : '') + '<div class="name">' + esc(cap(a.name)) + ' <span>' + esc(a.role) + '</span></div><div class="now" title="' + esc(n.text) + '">' + esc(n.text) + '</div></article>';
}
function renderChart(s) {
  var agents = s.org ? s.org.agents : [];
  var director = s.org ? byName[s.org.director] : null;
  var working = agents.filter(function (a) { return nowLine(s, a).cls !== 'is-idle'; }).length;
  setHtml($('orgSub'), plural(agents.length, 'agent') + ' · ' + (working ? working + ' at work' : 'all idle'));
  var h = '';
  if (director) h += agentCard(s, director, true);
  var rest = agents.filter(function (a) { return a !== director && !isDesk(a); });
  var groups = [];
  rest.forEach(function (a) {
    var g = a.group || '';
    var found = groups.find(function (x) { return x.name === g; });
    if (found) found.agents.push(a); else groups.push({ name: g, agents: [a] });
  });
  var named = groups.some(function (g) { return g.name; });
  if (rest.length && director) h += '<div class="conn"></div>';
  groups.forEach(function (g) {
    h += '<div class="group" style="--gc:' + g.agents[0].c + '">' + (named ? '<h3><i></i>' + esc(g.name || 'other') + '</h3>' : '') + g.agents.map(function (a) { return agentCard(s, a, false); }).join('') + '</div>';
  });
  var desks = agents.filter(isDesk);
  if (desks.length) h += '<div class="apart">' + desks.map(function (a) { return agentCard(s, a, false); }).join('') + '<p>' + esc(cap(desks[0].name)) + ' takes no tasks and touches no files. People talk to it; it files issues in Inbox; ' + esc(director ? cap(director.name) : 'the Director') + ' takes it from there.</p></div>';
  else if (s.org) h += '<div class="apart"><p>The chat on this page is answered by the library&#39;s front desk; this organization has none of its own.</p></div>';
  setHtml($('chart'), h || '<div class="empty">no organization loaded</div>');
}

function liveCards(s) {
  var h = '';
  (s.runs || []).forEach(function (r) {
    if (r.kind === 'mechanical') {
      var steps = r.steps || [];
      var on = steps.findIndex(function (x) { return x.state === 'on'; });
      h += '<div class="live loop">' + glyph('mechanical loop') + '<div class="head"><b>Mechanical loop</b><span class="role">no model</span><span class="task">executing ' + (r.task ? taskLink(s, r.task) + ' ' : '') + esc(r.title || '') + '</span><span class="where">this laptop · ' + (on >= 0 ? 'step ' + (on + 1) + ' of ' + steps.length : ago(r.startedAt)) + '</span></div>';
      h += '<div class="steps">' + steps.map(function (x) { return '<i class="' + x.state + '"></i>'; }).join('') + '</div>';
      h += '<div class="nums">' + steps.map(function (x) { return (x.state === 'done' ? 'done ' : x.state === 'on' ? 'now ' : x.state === 'failed' ? 'failed ' : 'then ') + '<b>' + esc(x.handler) + '</b>'; }).join(' · ') + '</div></div>';
      return;
    }
    var a = byName[r.who] || { name: r.who, role: '', c: 'var(--ink-3)' };
    var pct = r.maxTurns ? Math.min(100, Math.round(100 * r.turns / r.maxTurns)) : 0;
    h += '<div class="live" style="--c:' + a.c + '">' + avatar(a) + '<div class="head"><b>' + esc(cap(a.name)) + '</b><span class="role">' + esc(a.role) + '</span><span class="task">' + (r.task ? 'on ' + taskLink(s, r.task) + ' ' + esc(r.title || '') : 'on ' + esc(r.title || 'a run')) + '</span><span class="where">this laptop · ' + ago(r.startedAt) + '</span></div>';
    h += '<div class="bar"><i style="width:' + pct + '%"></i></div>';
    h += '<div class="nums">turn <b>' + r.turns + '</b>' + (r.maxTurns ? ' of ' + r.maxTurns : '') + ' · <b>' + r.toolCalls + '</b> tool calls' + (r.denied ? ' (' + r.denied + ' denied)' : '') + (r.maxBudgetUsd ? ' · $' + r.maxBudgetUsd + ' cap' : '') + (r.leaseUntil ? ' · lease until ' + hm(r.leaseUntil) : '') + '</div>';
    if (r.now) h += '<div class="what"><span class="verb">now</span> ' + esc(r.now) + '</div>';
    if (r.said) h += '<div class="said">“' + esc(r.said) + '”</div>';
    h += '</div>';
  });
  remoteRuns(s).forEach(function (x) {
    if (x.mechanical) {
      h += '<div class="live loop remote">' + glyph('mechanical loop') + '<div class="head"><b>Mechanical loop</b><span class="role">no model</span><span class="task">executing ' + taskLink(s, x.task.number) + ' ' + esc(x.task.title) + '</span><span class="where">' + esc(x.lease.holder) + ' · ' + ago(x.lease.at) + '</span></div><div class="nums">seen on the board: lease until ' + hm(x.lease.until) + ' · the steps stay on that laptop</div></div>';
      return;
    }
    var a = x.agent || { name: x.task.agent || 'an agent', role: '', c: 'var(--ink-3)' };
    h += '<div class="live remote" style="--c:' + a.c + '">' + avatar(a) + '<div class="head"><b>' + esc(cap(a.name)) + '</b><span class="role">' + esc(a.role) + '</span><span class="task">on ' + taskLink(s, x.task.number) + ' ' + esc(x.task.title) + '</span><span class="where">' + esc(x.lease.holder) + ' · ' + ago(x.lease.at) + '</span></div><div class="nums">seen on the board: lease until ' + hm(x.lease.until) + ' · turns and cost stay on that laptop</div></div>';
  });
  return h;
}
var FOLDABLE = { read: 'files', 'looked for': 'searches', 'searched for': 'searches' };
var CODE = { read: 1, wrote: 1, edited: 1, removed: 1, ran: 1, listed: 1, fetched: 1 };
function feedGroups(events) {
  var groups = [];
  events.forEach(function (e) {
    var last = groups[groups.length - 1];
    if (last && FOLDABLE[e.verb] && last.verb === e.verb && last.who === e.who && last.task === e.task && last.level === e.level) { last.items.push(e); return; }
    groups.push({ who: e.who, verb: e.verb, task: e.task, level: e.level, items: [e] });
  });
  return groups;
}
function passes(e) {
  if (filter === 'all') return true;
  if (filter === 'needs') return !!e.needs;
  if (filter === 'errors') return e.level === 'error' || e.level === 'warn';
  if (filter === 'loops') return !!LOOPS[e.who];
  return e.who === filter;
}
function renderFilters(s) {
  var counts = {};
  s.events.forEach(function (e) { if (byName[e.who]) counts[e.who] = (counts[e.who] || 0) + 1; });
  var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7);
  var b = function (key, label, c) { return '<button data-filter="' + esc(key) + '" class="' + (filter === key ? 'on' : '') + '"' + (c ? ' style="--c:' + c + '"' : '') + '>' + (c ? '<i></i>' : '') + esc(label) + '</button>'; };
  var h = b('all', 'everything') + b('needs', 'needs a human') + b('errors', 'errors and warnings');
  top.forEach(function (n) { h += b(n, cap(n), byName[n].c); });
  h += b('loops', 'the harness', 'var(--loop)');
  setHtml($('filters'), h);
}
function renderFeed(s) {
  var h = '';
  var live = liveCards(s);
  if (live) h += '<h3 class="band">Now</h3>' + live;
  var events = s.events.filter(passes).slice().reverse();
  h += '<h3 class="band">' + (live ? 'Earlier' : 'What happened') + '</h3>';
  if (!events.length) h += '<div class="empty">' + (s.events.length ? 'nothing matches this filter' : 'nothing yet · the first tick writes here') + '</div>';
  feedGroups(events).forEach(function (g) {
    var e = g.items[0];
    var a = byName[e.who];
    var cls = 'ev ' + (e.level !== 'info' ? e.level : '') + (e.needs ? ' needs' : '');
    var head = '<div class="head"><b>' + esc(a ? cap(a.name) : e.who) + '</b>' + (a ? '<span class="role">' + esc(a.role) + '</span>' : '') + (e.task ? '<span class="task">' + taskLink(s, e.task) + '</span>' : '') + (e.where ? '<span class="task">on ' + esc(e.where) + '</span>' : '') + '<time>' + when(e.at) + '</time></div>';
    var what;
    if (g.items.length > 1) {
      var key = e.id;
      var open = !!unfolded[key];
      what = '<div class="what"><span class="verb">' + esc(e.verb) + '</span> <code>' + esc(e.text) + '</code> <span class="verb">and ' + (g.items.length - 1) + ' more ' + FOLDABLE[e.verb] + '</span></div>';
      what += '<span class="fold" data-unfold="' + key + '">' + (open ? 'hide' : 'show') + '</span>';
      if (open) what += '<ul class="more">' + g.items.slice(1).map(function (x) { return '<li><code>' + esc(x.text) + '</code> <span class="dim">' + hms(x.at) + '</span></li>'; }).join('') + '</ul>';
    } else if (e.verb === 'said') {
      what = '';
    } else {
      what = '<div class="what"><span class="verb">' + esc(e.verb) + '</span> ' + (CODE[e.verb] ? '<code>' + esc(e.text) + '</code>' : esc(e.text)) + '</div>';
    }
    var said = e.said ? '<div class="said">“' + esc(e.said) + '”</div>' : '';
    h += '<div class="' + cls + '" style="--c:' + (a ? a.c : 'var(--loop)') + '">' + (a ? avatar(a) : glyph(e.who)) + '<div>' + head + what + said + '</div></div>';
  });
  setHtml($('feed'), h);
}

function whereLine(s, t) {
  var r = runOf(s, 'task-' + t.number) || runOf(s, 'plan-' + t.number);
  var remote = remoteRuns(s).find(function (x) { return x.task.number === t.number; });
  var last = function (test) { return lastEvent(s, function (e) { return e.task === t.number && test(e); }); };
  var e;
  switch (t.status) {
    case 'Running': return r ? 'this laptop · ' + ago(r.startedAt) + (r.now ? ' · ' + r.now : '') : remote ? remote.lease.holder + ' · ' + ago(remote.lease.at) : 'on another laptop · no lease seen yet';
    case 'Executing': return r ? 'mechanical loop · ' + (r.now || 'running the plan') : 'mechanical loop' + (remote ? ' on ' + remote.lease.holder : ' on another laptop');
    case 'Approved': return 'approved · the mechanical loop runs the plan on its next tick';
    case 'Assigned': return 'waits for a free laptop';
    case 'Inbox': e = last(function (x) { return x.verb === 'filed'; }); return (e ? 'filed by ' + cap(e.who) + ' at ' + hm(e.at) + ' · ' : '') + 'waits for ' + (s.org ? cap(s.org.director) : 'the Director');
    case 'Review': {
      e = last(function (x) { return x.verb === 'finished' || x.verb === 'proposed'; });
      var parts = e ? e.text.split(' · ').filter(function (x) { return /pull request|pushed|plan/.test(x); }) : [];
      return (parts.length ? parts.join(' · ') + ' · ' : '') + 'waits for you' + (e && e.verb === 'proposed' ? ' to approve the plan' : '');
    }
    case 'Failed': e = last(function (x) { return x.level === 'error'; }); return e ? e.text.split(' · move')[0].slice(0, 90) + ' · move it back to Assigned to retry' : 'move it back to Assigned to retry';
    default: return '';
  }
}
function renderWork(s) {
  var open = (s.tasks || []).filter(function (t) { return t.status !== 'Done' && t.status !== 'Rejected'; });
  setHtml($('workSub'), open.length ? plural(open.length, 'open task') + ' · the board on GitHub has the rest' : 'the board on GitHub has the rest');
  var groups = [
    { title: 'Needs you', cls: 'needs', statuses: ['Review', 'Failed'] },
    { title: 'Moving', cls: '', statuses: ['Executing', 'Running', 'Approved', 'Assigned'] },
    { title: 'Waiting for ' + (s.org ? cap(s.org.director) : 'the Director'), cls: '', statuses: ['Inbox'] },
  ];
  var h = '';
  groups.forEach(function (g) {
    var list = open.filter(function (t) { return g.statuses.indexOf(t.status) >= 0; }).sort(function (a, b) { return g.statuses.indexOf(a.status) - g.statuses.indexOf(b.status) || b.number - a.number; });
    if (!list.length) return;
    h += '<div class="tgroup ' + g.cls + '"><h3>' + esc(g.title) + '</h3>' + list.map(function (t) {
      var a = t.agent ? byName[t.agent] : null;
      var chip = a ? '<span class="chip" style="--c:' + a.c + '">' + esc(cap(a.name)) + avatar(a) + '</span>' : '<span class="chip dim">' + (t.agent ? esc(t.agent) : 'no agent yet') + '</span>';
      return '<div class="task"><span class="status ' + t.status.toLowerCase() + '">' + t.status + '</span><div><div class="title"><a href="' + esc(t.url) + '" target="_blank">#' + t.number + '</a>' + esc(t.title) + '</div><div class="where">' + esc(whereLine(s, t)) + '</div></div>' + chip + '</div>';
    }).join('') + '</div>';
  });
  setHtml($('work'), h || '<div class="empty">' + (s.tasks.length ? 'nothing open · everything is Done or Rejected' : 'no tasks read yet · the first tick reads the board') + '</div>');
}

function renderChat(s) {
  var c = s.chat;
  var desk = s.org ? s.org.agents.find(isDesk) : null;
  setHtml($('deskSub'), c.busy ? 'answering…' : desk ? cap(desk.name) + ' answers from the board and files tasks' : 'answers from the board and files tasks');
  $('c-send').disabled = !!c.busy;
  var el = $('chat');
  var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 10 || !htmlCache.chat;
  var h = c.messages.length ? c.messages.map(function (m) {
    if (m.role === 'desk') return '<div class="msg desk">' + (desk ? avatar(desk) : '<span class="av"></span>') + '<div>' + esc(m.text) + '<div class="meta">' + hm(m.at) + (m.did && m.did.length ? ' · ' + esc(m.did.join('; ')) : '') + (m.costUsd ? ' · ~$' + m.costUsd.toFixed(2) : '') + '</div></div></div>';
    return '<div class="msg ' + m.role + '">' + esc(m.text) + '</div>';
  }).join('') + (c.busy ? '<div class="msg note">reading the board…</div>' : '') : '<div class="msg note">Nobody has said anything yet. Ask about the board, or ask for work to be done; it files the task and ' + esc(s.org ? cap(s.org.director) : 'the Director') + ' assigns it.</div>';
  var before = htmlCache.chat;
  setHtml(el, h);
  if (stick && before !== h) el.scrollTop = el.scrollHeight;
}

function render(s) {
  S = s;
  agentsOf(s);
  var v = view(s);
  document.body.dataset.view = v;
  renderHeader(s, v);
  if (v === 'gate') { renderGate(s); return; }
  renderChart(s);
  renderFilters(s);
  renderFeed(s);
  renderWork(s);
  renderChat(s);
}

// ---------- the agent card: one popover to the right, over the activity ----------
(function () {
  var pop = $('pop');
  var open = null, timer = 0;
  function show(el) {
    clearTimeout(timer);
    var a = byName[el.dataset.agent];
    if (!a) return;
    if (open && open !== el) open.classList.remove('is-open');
    open = el; el.classList.add('is-open');
    pop.style.setProperty('--c', a.c);
    var now = el.querySelector('.now').textContent;
    pop.innerHTML = '<div class="who">' + avatar(a) + '<div><b>' + esc(cap(a.name)) + '</b><span>' + esc(a.role) + '</span></div></div>' +
      (a.description ? '<p>' + esc(cap(a.description)) + '</p>' : '') +
      '<dl>' + (a.group ? '<dt>group</dt><dd>' + esc(a.group) + '</dd>' : '') +
      '<dt>model</dt><dd>' + esc(a.model) + '</dd>' +
      '<dt>tools</dt><dd>' + esc(a.tools.length ? a.tools.join(', ') : 'none') + (S.org && a.name === S.org.director ? ' + the inbox' : isDesk(a) ? ' + the board' : ' + the task') + '</dd>' +
      '<dt>writes</dt><dd>' + esc(a.writes) + '</dd>' +
      '<dt>now</dt><dd>' + esc(now) + '</dd></dl>' +
      '<div class="foot"><code>' + esc(a.file) + '</code><span class="dim">in the organization repository</span></div>';
    pop.classList.add('show');
    var r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(r.right + 10, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.max(12, Math.min(r.top - 6, window.innerHeight - 12 - h)) + 'px';
  }
  function hide() { clearTimeout(timer); pop.classList.remove('show'); if (open) { open.classList.remove('is-open'); open = null; } }
  function hideSoon() { clearTimeout(timer); timer = setTimeout(hide, 140); }
  var chart = $('chart');
  chart.addEventListener('mouseover', function (e) { var el = e.target.closest('.agent'); if (el && el !== open) show(el); else if (el) clearTimeout(timer); });
  chart.addEventListener('mouseout', function (e) { var el = e.target.closest('.agent'); if (el && !el.contains(e.relatedTarget)) hideSoon(); });
  chart.addEventListener('focusin', function (e) { var el = e.target.closest('.agent'); if (el) show(el); });
  chart.addEventListener('focusout', hideSoon);
  chart.addEventListener('scroll', hide, { passive: true });
  pop.addEventListener('mouseenter', function () { clearTimeout(timer); });
  pop.addEventListener('mouseleave', hideSoon);
  document.addEventListener('click', function (e) { if (!pop.contains(e.target)) hide(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
})();

// ---------- clicks ----------
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act],[data-loop],[data-filter],[data-unfold],[data-run-fix],[data-copy]');
  if (!t) return;
  if (t.dataset.loop) { post('/api/loops/' + t.dataset.loop + '/' + t.dataset.do); return; }
  if (t.dataset.filter) { filter = t.dataset.filter; render(S); return; }
  if (t.dataset.unfold) { unfolded[t.dataset.unfold] = !unfolded[t.dataset.unfold]; delete htmlCache.feed; render(S); return; }
  if (t.dataset.runFix) {
    var values = {};
    document.querySelectorAll('input[data-fix="' + t.dataset.runFix + '"]').forEach(function (i) { values[i.dataset.key] = i.value; });
    postJson('/api/fix/' + t.dataset.runFix, { values: values }).then(function (j) { if (j.error) alert(j.error); });
    return;
  }
  if (t.dataset.copy) {
    var url = t.dataset.url;
    var openIt = function () { window.open(url, '_blank'); };
    if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copy).then(openIt, openIt); else openIt();
    return;
  }
  switch (t.dataset.act) {
    case 'gate': manualGate = !manualGate; render(S); break;
    case 'dash': manualGate = false; shownOk = true; if (passTimer) { clearTimeout(passTimer); passTimer = null; } render(S); break;
    case 'recheck': post('/api/preflight'); break;
    case 'cancel-fix': post('/api/fix/cancel'); break;
    case 'create': createOrg(); break;
    case 'rebuild': builderBuilt = false; delete htmlCache.builder; renderBuilder(S); break;
    case 'use-folder': postJson('/api/folder', { folder: $('u-folder').value.trim() }).then(function (j) { if (j.error) alert(j.error); }); break;
    default: break;
  }
});
function sendChat() {
  var input = $('c-text');
  var text = input.value.trim();
  if (!text) return;
  postJson('/api/chat', { text: text }).then(function (j) { if (j.error) alert(j.error); else input.value = ''; });
}
$('c-send').addEventListener('click', sendChat);
$('c-text').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });

// ---------- the stream ----------
function connect() {
  var es = new EventSource('/events');
  es.onmessage = function (e) { connected = true; render(JSON.parse(e.data)); };
  es.onerror = function () { connected = false; if (S) renderHeader(S, document.body.dataset.view); };
}
fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) { connected = true; render(s); connect(); });
setInterval(function () { if (S && document.body.dataset.view === 'dash') { delete htmlCache.feed; delete htmlCache.work; delete htmlCache.chart; render(S); } }, 30000);
</script>
</body>
</html>
`;

/* =====================================================================
   RADIO CHANGE: shared audio engine for the mockups.
   One chain for every direction: stream -> 10-band EQ -> analyser -> volume.
   A classic script, not a module, so a dev server's MIME table can't break it.

   ?demo        synthesized test signal + rotating fake titles instead of the stream
   ?silent      full chain with the output muted; the visuals still react
   ?firstvisit  behave like a browser that refuses unprompted sound
   ?skiptest    the real stream, but the song changes every 5 seconds from a
                fixed list, to watch a change happen (?skiptest=3 for another pace)
   ===================================================================== */
(function(){
"use strict";

const STREAM_URL="https://s26.myradiostream.com:22656/stream";
const STATS_BASE="https://s26.myradiostream.com:22656/";
const LOGO="https://myradiostream.com/station/uploads/logo/81785af28ee3c7d0e28c3461a37fdd506ed6a3ff.png";
const Q=new URLSearchParams(location.search);
const DEMO=Q.has("demo"),SILENT=Q.has("silent"),GATE=Q.has("firstvisit"),SKIP=Q.has("skiptest");
const KEEP=!DEMO&&!SKIP;          // made-up running orders never reach the saved history

const NB=10;
const FREQS=[31,62,125,250,500,1000,2000,4000,8000,16000];
const LABELS=["31","62","125","250","500","1K","2K","4K","8K","16K"];
const PRESETS={
  FLAT:[0,0,0,0,0,0,0,0,0,0],
  MOSH:[7,6,4,0,-3,-1,2,5,7,7],
  BASS:[6,5,3,1,0,0,0,0,0,0],
  VOCAL:[-4,-3,-2,0,2,3,3,2,1,0],
};

/* ---------------- events ---------------- */
const subs={};
function on(evt,fn){(subs[evt]||(subs[evt]=[])).push(fn);return radio;}
function emit(evt,arg){(subs[evt]||[]).forEach(fn=>{try{fn(arg);}catch(e){console.error(e);}});}

/* ---------------- settings survive reloads ---------------- */
let store={};
try{store=JSON.parse(localStorage.getItem("radiochange")||"{}")||{};}catch(e){}
/* Until the listener chooses a sound, the station's own is on: MOSH. `chose` is
   kept with the curve, so a choice of FLAT is a choice like any other. Saves
   from before it was kept say nothing either way: there a curve counts as
   chosen unless it is flat, which is what everybody had who never touched it. */
let chose=typeof store.chose==="boolean"?store.chose:Array.isArray(store.eq)&&store.eq.some(v=>v);
const eq=PRESETS.MOSH.slice();    // dB
if(chose&&Array.isArray(store.eq))for(let i=0;i<NB;i++)
  eq[i]=typeof store.eq[i]==="number"&&isFinite(store.eq[i])?Math.max(-12,Math.min(12,store.eq[i])):0;
let vol=(typeof store.vol==="number"&&store.vol>0&&store.vol<=1)?store.vol:.8;   // 0..1
/* a mute is not kept: what is saved is the level it would come back to */
function save(){try{localStorage.setItem("radiochange",JSON.stringify({vol:vol||back,eq:eq,chose:chose}));}catch(e){}}

/* ---------------- audio graph ---------------- */
let ctx=null,analyser=null,master=null,input=null,audioEl=null,timeBuf=null,freqBuf=null;
const filters=[];
function initAudio(){
  ctx=new (window.AudioContext||window.webkitAudioContext)();
  master=ctx.createGain();
  master.gain.value=SILENT?0:vol*vol;
  analyser=ctx.createAnalyser();
  analyser.fftSize=2048;
  analyser.smoothingTimeConstant=.55;
  analyser.minDecibels=-90;analyser.maxDecibels=-18;
  timeBuf=new Uint8Array(analyser.fftSize);
  freqBuf=new Uint8Array(analyser.frequencyBinCount);
  let prev=null;
  for(let i=0;i<NB;i++){
    const f=ctx.createBiquadFilter();
    f.type="peaking";f.frequency.value=FREQS[i];f.Q.value=1.1;f.gain.value=eq[i];
    if(prev)prev.connect(f);
    prev=f;filters.push(f);
  }
  input=filters[0];
  prev.connect(analyser);          // analyser sits after the EQ so the visuals show it
  analyser.connect(master);
  master.connect(ctx.destination);
}

/* Mute and a volume of nothing are the same thing: taking the volume to zero
   mutes, and muting takes the volume to zero. `back` is the level a mute comes
   back to: the last one the volume rested at, so a drag down to nothing returns
   to where it set out from and not to its last crumb. */
let muted=false,back=vol,restTO=null;
function applyGain(){
  if(master&&!SILENT)master.gain.setTargetAtTime(vol*vol,ctx.currentTime,.03);
}
function setVolume(v){
  vol=Math.min(1,Math.max(0,v));radio.volume=vol;save();
  clearTimeout(restTO);
  if(vol>0)restTO=setTimeout(()=>{back=vol;},500);
  applyGain();
  if(muted!==(vol===0)){muted=!muted;radio.muted=muted;emit("mute",muted);}
  emit("volume",vol);
}
/* mute keeps the stream running, so the page stays alive and unmuting is instant */
function setMuted(m){
  if(!!m===muted)return;
  if(m){back=vol;setVolume(0);}else setVolume(back);
}
function presetName(){
  const hit=Object.entries(PRESETS).find(([n,g])=>g.every((v,i)=>Math.abs(v-eq[i])<.5));
  return hit?hit[0]:null;
}
function setBand(i,dB){
  eq[i]=Math.max(-12,Math.min(12,dB));chose=true;save();
  if(filters[i])filters[i].gain.setTargetAtTime(eq[i],ctx.currentTime,.03);
  emit("eq",eq);
}
/* all ten at once, for a control that moves the whole curve */
function setEq(g){
  for(let i=0;i<NB;i++){
    eq[i]=Math.max(-12,Math.min(12,g[i]));
    if(filters[i])filters[i].gain.setTargetAtTime(eq[i],ctx.currentTime,.03);
  }
  chose=true;save();emit("eq",eq);
}
function setPreset(name){
  const g=PRESETS[name];if(!g)return;
  for(let i=0;i<NB;i++){eq[i]=g[i];if(filters[i])filters[i].gain.setTargetAtTime(g[i],ctx.currentTime,.05);}
  chose=true;save();emit("eq",eq);
}

/* ---- test synth: 140 BPM kick / snare / hat / bass through the same chain ---- */
let synthOut=null,noiseBuf=null,nextNote=0,step=0,timer=null;
const SPB=60/140;
function env(g,t,a,peak,dec){
  g.gain.setValueAtTime(0,t);
  g.gain.linearRampToValueAtTime(peak,t+a);
  g.gain.exponentialRampToValueAtTime(.001,t+dec);
}
function kick(t){
  const o=ctx.createOscillator(),g=ctx.createGain();
  o.frequency.setValueAtTime(150,t);o.frequency.exponentialRampToValueAtTime(45,t+.11);
  env(g,t,.002,.95,.24);o.connect(g);g.connect(synthOut);o.start(t);o.stop(t+.26);
}
function noise(t,type,freq,q,peak,dec){
  const s=ctx.createBufferSource(),g=ctx.createGain(),f=ctx.createBiquadFilter();
  s.buffer=noiseBuf;f.type=type;f.frequency.value=freq;f.Q.value=q;
  env(g,t,.001,peak,dec);s.connect(f);f.connect(g);g.connect(synthOut);s.start(t);s.stop(t+dec+.02);
}
function bass(t,f,dur){
  const o=ctx.createOscillator(),g=ctx.createGain(),lp=ctx.createBiquadFilter();
  o.type="sawtooth";o.frequency.value=f;lp.type="lowpass";lp.frequency.value=900;lp.Q.value=2;
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.42,t+.008);
  g.gain.setValueAtTime(.42,t+dur-.04);g.gain.linearRampToValueAtTime(0,t+dur);
  o.connect(lp);lp.connect(g);g.connect(synthOut);o.start(t);o.stop(t+dur+.02);
}
const RIFF={0:55,3:55,6:82.41,8:55,11:65.41,14:73.42};
function schedule(){
  while(nextNote<ctx.currentTime+.12){
    const s=step%16,t=nextNote;
    if(s%4===0)kick(t);
    if(s===4||s===12)noise(t,"bandpass",1900,.9,.5,.16);
    noise(t,"highpass",7500,.7,.16,.05);
    if(RIFF[s]!==undefined)bass(t,RIFF[s],SPB*.48);
    nextNote+=SPB/2;step++;
  }
}
function startSynth(){
  if(!synthOut){
    synthOut=ctx.createGain();synthOut.connect(input);
    noiseBuf=ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate);
    const d=noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
  }
  nextNote=ctx.currentTime+.06;
  timer=setInterval(schedule,25);
}
function stopSynth(){if(timer!==null){clearInterval(timer);timer=null;}}

/* ---------------- transport: off -> dialing -> on ----------------
   plus "blocked": the browser refused unprompted sound and we wait for a touch */
let state="off",connectTO=null,retryTO=null,stallTO=null,retryN=0,unblockEvent=null;
function setState(s){
  if(s===state)return;
  state=s;radio.state=s;
  document.documentElement.dataset.air=s;
  if("mediaSession"in navigator)
    navigator.mediaSession.playbackState=(s==="off"||s==="blocked")?"paused":"playing";
  emit("state",s);
}
function fail(msg){emit("error",msg);stop();}
/* a page with no play button sets radio.keepAlive: a lost signal redials by itself */
function lost(msg){
  if(state==="off"||state==="blocked")return;
  if(!radio.keepAlive){fail(msg);return;}
  emit("error",msg+". RECONNECTING");
  clearTimeout(connectTO);clearTimeout(retryTO);clearTimeout(stallTO);
  setState("dialing");
  retryTO=setTimeout(connect,Math.min(15000,1500*Math.pow(2,retryN++)));
}
function connect(){
  clearTimeout(connectTO);
  /* always a fresh connection: a paused live stream resumes stale */
  audioEl.src=STREAM_URL+"?nocache="+Date.now();
  connectTO=setTimeout(()=>{
    if(state!=="dialing")return;
    if(radio.keepAlive)lost("NO AUDIO YET");else emit("error","STILL CONNECTING. NO AUDIO YET");
  },9000);
  const p=audioEl.play();
  if(p)p.catch(e=>{
    if(state==="off"||(e&&e.name==="AbortError"))return;
    if(e&&e.name==="NotAllowedError"){block();return;}
    lost("COULD NOT START: "+((e&&e.message)||e));
  });
}

async function start(){
  if(state!=="off"&&state!=="blocked")return;
  setState("dialing");
  try{
    if(!ctx)initAudio();
    await ctx.resume();
    if(DEMO){startSynth();setTimeout(()=>{if(state==="dialing")setState("on");},500);return;}
    if(!audioEl){
      audioEl=new Audio();
      audioEl.crossOrigin="anonymous";     /* server sends ACAO:* */
      audioEl.preload="none";audioEl.playsInline=true;
      ctx.createMediaElementSource(audioEl).connect(input);
      audioEl.addEventListener("playing",()=>{
        clearTimeout(connectTO);clearTimeout(stallTO);retryN=0;
        if(state==="dialing")setState("on");
      });
      audioEl.addEventListener("waiting",()=>{
        clearTimeout(stallTO);
        stallTO=setTimeout(()=>{if(state==="on")lost("SIGNAL STALLED");},12000);
      });
      audioEl.addEventListener("ended",()=>lost("STREAM ENDED"));
      audioEl.addEventListener("error",()=>{
        if(state==="off")return;
        lost("SIGNAL LOST: MEDIA ERROR "+(audioEl.error?audioEl.error.code:""));
      });
    }
    connect();
  }catch(e){
    if(state!=="off")fail("COULD NOT START: "+((e&&e.message)||e));
  }
}
function stop(){
  clearTimeout(connectTO);clearTimeout(retryTO);clearTimeout(stallTO);
  setState("off");
  stopSynth();
  if(audioEl){audioEl.pause();audioEl.removeAttribute("src");audioEl.load();}
}
function toggle(){state==="off"?start():stop();}

/* Go on air unprompted. Browsers refuse sound until the visitor has touched the
   page (returning listeners are often let through); then we wait, and the first
   click, tap or key anywhere starts it. */
function block(){
  if(state==="blocked")return;
  clearTimeout(connectTO);
  if(audioEl){audioEl.pause();audioEl.removeAttribute("src");audioEl.load();}
  setState("blocked");
  const go=e=>{
    ["click","touchend","keydown"].forEach(t=>removeEventListener(t,go,true));
    unblockEvent=e;
    start();
  };
  ["click","touchend","keydown"].forEach(t=>addEventListener(t,go,true));
}
async function autostart(){
  if(state!=="off")return;
  if(GATE){block();return;}
  try{
    if(!ctx)initAudio();
    ctx.resume().catch(()=>{});
    await new Promise(r=>setTimeout(r,250));     // resume() just hangs when refused
    if(ctx.state!=="running"){block();return;}
  }catch(e){block();return;}
  start();
}

/* ---------------- per-frame analysis ----------------
   sample() is safe to call from several places per frame; it only works once. */
const S={on:false,level:0,bass:0,mid:0,treble:0,
         beat:false,snare:false,tick:false,   // onsets this frame: kick, snare, hats
         bands:new Float32Array(NB),      // post-EQ energy per band, 0..1
         bandsN:new Float32Array(NB),     // same, normalised to each band's recent peak
         wave:null,freq:null};
const TILT=[1,1,1,1.05,1.1,1.2,1.3,1.45,1.7,3.2];   // lift the quiet top end
const bandMax=new Float32Array(NB).fill(.3);
let lastT=0;
/* onset = a fast envelope pulling clear of a slow one, against its own usual spread.
   Works on compressed rock where the raw level barely moves. */
function mkOnset(gap){return {fast:0,slow:0,dev:.02,armed:true,last:0,gap:gap};}
const oKick=mkOnset(200),oSnare=mkOnset(200),oHat=mkOnset(110);
function onset(o,e,dt,now){
  o.fast+=(e-o.fast)*Math.min(1,dt*45);
  o.slow+=(e-o.slow)*Math.min(1,dt*3.5);
  const d=o.fast-o.slow;
  o.dev+=(Math.abs(d)-o.dev)*Math.min(1,dt*1.2);
  const thr=Math.max(.01,o.dev*1.25);
  let hit=false;
  if(d>thr){
    if(o.armed&&now-o.last>o.gap){hit=true;o.last=now;}
    o.armed=false;
  }else if(d<thr*.4)o.armed=true;
  return hit;
}

function binAvg(f0,f1,hz){
  const lo=Math.max(1,Math.round(f0/hz)),hi=Math.min(freqBuf.length,Math.max(lo+1,Math.round(f1/hz)));
  let s=0;for(let k=lo;k<hi;k++)s+=freqBuf[k];
  return s/((hi-lo)*255);
}
function sample(){
  const now=performance.now();
  if(now-lastT<3)return S;
  const dt=Math.min(.1,(now-lastT)/1000);lastT=now;
  S.beat=S.snare=S.tick=false;
  S.on=state==="on"&&!!analyser;
  if(!S.on){
    for(let i=0;i<NB;i++){S.bands[i]*=.9;S.bandsN[i]*=.9;}
    S.level*=.9;S.bass*=.9;S.mid*=.9;S.treble*=.9;S.wave=S.freq=null;
    return S;
  }
  analyser.getByteFrequencyData(freqBuf);
  analyser.getByteTimeDomainData(timeBuf);
  S.freq=freqBuf;S.wave=timeBuf;
  const hz=ctx.sampleRate/analyser.fftSize;
  for(let i=0;i<NB;i++){
    const v=Math.min(1,binAvg(FREQS[i]/Math.SQRT2,FREQS[i]*Math.SQRT2,hz)*TILT[i]);
    const p=S.bands[i];
    S.bands[i]=p+(v-p)*(1-Math.exp(-dt/(v>p?.02:.11)));   // fast attack, slow release
    bandMax[i]=Math.max(.25,bandMax[i]-dt*.03,S.bands[i]);
    S.bandsN[i]=S.bands[i]/bandMax[i];
  }
  let rms=0;
  for(let i=0;i<timeBuf.length;i+=4){const x=(timeBuf[i]-128)/128;rms+=x*x;}
  const lv=Math.min(1,Math.sqrt(rms/(timeBuf.length/4))*2.6);
  S.level+=(lv-S.level)*(1-Math.exp(-dt/(lv>S.level?.025:.16)));
  S.bass=(S.bands[0]+S.bands[1]+S.bands[2])/3;
  S.mid=(S.bands[3]+S.bands[4]+S.bands[5]+S.bands[6])/4;
  S.treble=(S.bands[7]+S.bands[8]+S.bands[9])/3;
  S.beat=onset(oKick,binAvg(40,140,hz),dt,now);
  S.snare=onset(oSnare,binAvg(1800,5200,hz),dt,now);
  S.tick=onset(oHat,binAvg(7000,13000,hz),dt,now);
  return S;
}

/* ---------------- now playing + just played ---------------- */
const SITE=/\s*[\(\[][^\)\]]*\b[a-z0-9-]+\.(com|net|org|pm|ru|info|me|cc|fm|to|biz|co)\b[^\)\]]*[\)\]]/gi;
/* Two things are remembered about songs: their covers (see artwork), and what a
   tag turned out to say where the lookup read it differently from how it is
   written (see holdsBoth): the tag, tidied, against the song it is. One number
   for both, to put up whenever the lookup or the matching changes: what was
   kept under an older one is thrown out. */
const ART="radiochange.art12",READS="radiochange.reads12";
let reads={};
try{
  Object.keys(localStorage).forEach(k=>{
    if(/^radiochange\.(art|reads)\d*$/.test(k)&&k!==ART&&k!==READS)localStorage.removeItem(k);
  });
  reads=JSON.parse(localStorage.getItem(READS)||"{}")||{};
}catch(e){}
function tidy(raw){
  /* some uploads use _ for spaces, and carry the site they came from: "(mp3.pm)" */
  const s=raw.replace(/[_\s]+/g," ").replace(SITE,"")
    .replace(/\b(\w+n) t\b/gi,"$1't").replace(/\bI m\b/g,"I'm")      /* tags that lost their apostrophes */
    .trim();
  let parts=s.split(/ [-\u2013\u2014] /).map(x=>x.trim()).filter(Boolean);
  /* "01 - artist - title": a bare number ahead of two more parts is a track number.
     With only two parts it is a band: "311 - Down" */
  if(parts.length>=3&&/^\d{1,3}\.?$/.test(parts[0]))parts.shift();
  /* "01. artist", "6.title": a number glued on with punctuation. "3 Doors Down" stays */
  parts=parts.map(p=>p.replace(/^\d{1,3}[.)]\s*(?=\D)/,"")).filter(Boolean);
  /* "artist cd1", "artist disc 2" */
  if(parts.length>1)parts[0]=parts[0].replace(/\s+(cd|disc|disk)\s*\d+$/i,"");
  /* "Artist-Title - Artist-Title": the same tag in both fields, split with a bare hyphen */
  if(parts.length===2&&parts[0].toLowerCase()===parts[1].toLowerCase())parts.pop();
  if(parts.length===1){
    const h=parts[0].split("-").map(x=>x.trim());
    if(h.length===2&&h[0].length>1&&h[1].length>1)parts=h;
  }
  /* collapse "artist - 01 artist - title" duplication */
  if(parts.length>=3){
    const a=parts[0].toLowerCase(),b=parts[1].replace(/^\d{1,3}[\s.\-]+/,"").toLowerCase();
    if(a===b)parts.splice(1,1);
  }
  /* "Killers, The": filed under K, but the name is The Killers */
  if(parts.length>1)parts[0]=parts[0].replace(/^(.+),\s*(the|a|an)$/i,"$2 $1");
  const t=parts.join(" - ");
  /* a tag that has been read differently before is that song at once */
  return Object.prototype.hasOwnProperty.call(reads,t)?reads[t]:t;
}
function split(text){
  const p=text.split(" - ");
  return p.length>1?{text:text,artist:p[0],title:p.slice(1).join(" - ")}
                   :{text:text,artist:"",title:text};
}
let track=null,hist=[];
try{hist=(JSON.parse(localStorage.getItem("radiochange.hist")||"[]")||[])
      .filter(x=>typeof x==="string").map(x=>tidy(x)).filter(Boolean).slice(0,8);
    /* older saves joined artist and title differently: write them back in today's form */
    if(KEEP)localStorage.setItem("radiochange.hist",JSON.stringify(hist));}catch(e){}
/* The list is held back until the station has been asked for its own (see
   seed), so a stale one from the last visit is not put up and then replaced. */
let seeded=!KEEP;
function played(){return seeded?hist.filter(t=>!track||t!==track.text).map(split):[];}
function setTrack(text){
  if((text||"")===(track?track.text:""))return;
  track=text?split(text):null;radio.track=track;
  if(text&&hist[0]!==text){
    hist=[text].concat(hist.filter(t=>t!==text)).slice(0,8);
    /* the test signal's made-up titles never reach the saved history */
    if(KEEP)try{localStorage.setItem("radiochange.hist",JSON.stringify(hist));}catch(e){}
  }
  document.title=(text?text+" | ":"")+"Radio Change";
  if("mediaSession"in navigator)
    navigator.mediaSession.metadata=new MediaMetadata({
      title:track?track.title:"Radio Change",artist:track&&track.artist?track.artist:"Radio Change",
      artwork:[{src:LOGO,sizes:"512x512",type:"image/png"}]});
  emit("track",track);emit("history",played());
  /* give the OS media card the real cover once it is known */
  if(text&&"mediaSession"in navigator)art(text,512,u=>{
    if(!u||!track||track.text!==text)return;
    navigator.mediaSession.metadata=new MediaMetadata({
      title:track.title,artist:track.artist||"Radio Change",
      artwork:[{src:u,sizes:"512x512",type:"image/jpeg"}]});
  });
}
/* The lookup has found that a tag says something else than it seemed to (see
   holdsBoth). It is that song from now on: in the list, on air if it is the one
   playing, and each time the station sends the tag again (see tidy). */
function reread(text,song){
  if(song===text)return;
  reads[text]=song;
  const keys=Object.keys(reads);
  if(keys.length>80)delete reads[keys[0]];
  try{localStorage.setItem(READS,JSON.stringify(reads));}catch(e){}
  hist=hist.map(t=>t===text?song:t).filter((t,i,a)=>a.indexOf(t)===i);
  if(KEEP)try{localStorage.setItem("radiochange.hist",JSON.stringify(hist));}catch(e){}
  if(track&&track.text===text)setTrack(song);    // which tells the page about the list as well
  else emit("history",played());
}
/* What the station played before this page was opened. The server keeps its
   own list, newest first, the song on air at the head of it, and answers JSONP
   like the stats do: so a first visit starts with a full "just played", not an
   empty one. Asked for once, on arrival. If there is no answer, what this
   browser remembers from last time will do. */
function seed(){
  jsonp(STATS_BASE+"played?sid=1&type=json&_="+Date.now()+"&callback=").then(r=>{
    const list=(Array.isArray(r)?r:[]).map(x=>x&&typeof x.title==="string"?tidy(x.title):"").filter(Boolean);
    seeded=true;
    if(list.length){
      const head=track?track.text:list[0];
      hist=[head].concat(list).filter((t,i,a)=>a.indexOf(t)===i).slice(0,8);
      try{localStorage.setItem("radiochange.hist",JSON.stringify(hist));}catch(e){}
      if(!track){setTrack(head);return;}       // which tells the page about the list as well
    }
    emit("history",played());
  });
}
/* Shoutcast v2 JSONP stats: no CORS needed */
let blanks=0;
function poll(){
  const cb="rc_"+Math.random().toString(36).slice(2);
  const s=document.createElement("script");
  const done=()=>{delete window[cb];s.remove();clearTimeout(to);};
  const to=setTimeout(done,8000);
  window[cb]=r=>{
    done();
    /* The server's "stream status" flag drops to 0 for a moment now and then while
       the music and the title carry on, so the title is what counts. One empty
       answer does not blank the page either: only three in a row do. */
    const t=(r&&typeof r.songtitle==="string")?tidy(r.songtitle):"";
    if(t){blanks=0;setTrack(t);}
    else if(++blanks>=3)setTrack("");
  };
  s.onerror=done;
  s.src=STATS_BASE+"stats?sid=1&json=1&callback="+cb+"&_="+Date.now();
  document.head.append(s);
}
/* ---------------- artwork ----------------
   The stream only carries "artist - title", so covers are looked up: first in
   the iTunes Search API, then in Deezer's (neither needs a key; both answer
   JSONP). A cover only counts when both the artist and the song agree, or a
   namesake's sleeve gets shown. A title that turns out to hold the act as well
   as the song is read that way. If the song has no sleeve anywhere, a picture
   of the artist stands in. A name that looks misspelt is tried again as the
   name it most likely is, and a double bill as the act billed first. A miss is
   remembered too, so nothing is looked up twice. */
let artStore={};
try{artStore=JSON.parse(localStorage.getItem(ART)||"{}")||{};}catch(e){}
const artWait={};
let artQueue=Promise.resolve();
function norm(s){
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
}
/* compared with the spaces out: "K.W.S." is "KWS" over there */
const flat=x=>norm(x||"").replace(/ /g,"");
/* "(Live)", "[Remastered]": notes on a name, not part of it */
const bare=x=>(x||"").replace(/\s*[\(\[][^\)\]]*[\)\]]/g,"").trim();
/* a name without a leading "The", for telling acts apart */
const nameKey=x=>flat(x).replace(/^the/,"");
/* A name with its number words as figures, up to ninety-nine. The tag says
   "Three Doors Down" and the catalogues "3 Doors Down", or the other way about
   with Matchbox Twenty: a name is compared as written, and then like this. */
const NUMS={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,
            thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,
            twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
const NUM_WORD=new RegExp("\\b("+Object.keys(NUMS).join("|")+")\\b","gi");
const NUM_PAIR=/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi;
const figures=x=>(x||"").replace(NUM_PAIR,(m,t,u)=>NUMS[t.toLowerCase()]+NUMS[u.toLowerCase()])
                        .replace(NUM_WORD,m=>NUMS[m.toLowerCase()]);
const either=(same,a,b)=>same(a,b)||same(figures(a),figures(b));
/* How many single-letter slips (one wrong, one missing or one extra) separate two names. */
function slips(a,b){
  let row=[];
  for(let j=0;j<=b.length;j++)row[j]=j;
  for(let i=1;i<=a.length;i++){
    let prev=row[0];row[0]=i;
    for(let j=1;j<=b.length;j++){
      const keep=row[j];
      row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));
      prev=keep;
    }
  }
  return row[b.length];
}
/* Tags are typed by hand, so "the same act" allows for how they go wrong. */
function sameAct(artist,theirs){
  const a=flat(artist),b=flat(theirs);
  if(a.length<2||b.length<2)return false;
  if(a.includes(b)||b.includes(a))return true;                  // "Bryan Adams Stevie Vann" has Bryan Adams in it
  const ka=nameKey(artist),kb=nameKey(theirs);
  if(ka.length>=6&&slips(ka,kb)<=Math.floor(ka.length/5))return true;   // misspelt: "Deep Perple"
  /* initials: "B.Tyler" for Bonnie Tyler. Same surname, and every other word the same or its first letter */
  const wa=norm(artist).split(" "),wb=norm(theirs).split(" ");
  if(wa.length===wb.length&&wa.length>1&&wa[wa.length-1]===wb[wb.length-1])
    return wa.slice(0,-1).every((w,i)=>w===wb[i]||(w.length===1&&wb[i][0]===w)||(wb[i].length===1&&w[0]===wb[i]));
  return false;
}
function sameSong(title,theirs){
  const t=flat(bare(title)),x=flat(bare(theirs));
  if(!t||!x)return false;
  /* a short name has to be the same name; a longer one may carry extra words on either side */
  if(t===x||(t.length>3&&x.length>3&&(t.includes(x)||x.includes(t))))return true;
  if(t.length>=8&&slips(t,x)<=Math.floor(t.length/8))return true;       // a typo: "Total Eclipse ot the Heart"
  /* a censored listing: every star stands for one letter */
  if(theirs.includes("*")){
    const pat=bare(theirs).toLowerCase().replace(/[^a-z0-9*]+/g,"").replace(/\*/g,"[a-z0-9]");
    try{return pat.length>3&&new RegExp(pat).test(t);}catch(e){return false;}
  }
  return false;
}
/* both have to hold: the act and the song */
function agrees(artist,title,theirArtist,theirTitle){
  return either(sameAct,artist,theirArtist||"")&&either(sameSong,title,theirTitle||"");
}
/* Some tags put the lot in the title, "Counting Crows Accidentally In Love", and
   something else where the artist goes ("I'm in love"). A listing fits a title
   like that when the title's words divide in two with nothing over, its act one
   side and its song the other: in either order, a leading "The" on the act and
   a typo allowed. Gives the title read that way, {artist,title} in the tag's
   own words, or null. */
function holdsBoth(title,theirArtist,theirTitle){
  const w=bare(title).split(" ").filter(Boolean),a=nameKey(theirArtist||""),s=flat(bare(theirTitle||""));
  if(a.length<2||s.length<2)return null;
  const is=(x,y)=>x===y||(x.length>=8&&slips(x,y)<=Math.floor(x.length/8));
  for(let k=1;k<w.length;k++){
    const head=w.slice(0,k).join(" "),tail=w.slice(k).join(" ");
    if(is(nameKey(head),a)&&is(flat(tail),s))return {artist:head,title:tail};
    if(is(flat(head),s)&&is(nameKey(tail),a))return {artist:tail,title:head};
  }
  return null;
}
function jsonp(url){
  return new Promise(res=>{
    const cb="rcart_"+Math.random().toString(36).slice(2);
    const s=document.createElement("script");
    const done=v=>{delete window[cb];s.remove();clearTimeout(to);res(v);};
    const to=setTimeout(()=>done(null),7000);
    window[cb]=r=>done(r||{});
    s.onerror=()=>done(null);
    s.src=url+cb;
    document.head.append(s);
  });
}
/* each returns a cover url, "" for an honest miss, or null when the service did not answer;
   fits(theirArtist,theirTitle) says whether a listing is the song */
const SOURCES=[
  async(term,fits)=>{
    const r=await jsonp("https://itunes.apple.com/search?media=music&entity=song&limit=10&term="+encodeURIComponent(term)+"&callback=");
    if(!r)return null;
    const hit=(r.results||[]).find(x=>x.artworkUrl100&&fits(x.artistName,x.trackName||""));
    return hit?hit.artworkUrl100:"";
  },
  async(term,fits)=>{
    const r=await jsonp("https://api.deezer.com/search?limit=10&q="+encodeURIComponent(term)+"&output=jsonp&callback=");
    if(!r||r.error)return null;
    const hit=(r.data||[]).find(x=>x.album&&x.album.cover_big&&fits(x.artist&&x.artist.name,x.title||""));
    return hit?hit.album.cover_big:"";
  },
];
/* Who the tag most likely means, asked of Deezer's artist search. Either the
   act of exactly that name, or, failing that, a guess: a well-known act whose
   name is within a letter or two of it ("Deep Perple" is Deep Purple). Gives
   {name,picture,guessed}, "" when nobody fits, or null when there was no answer.
   With `lead`, the name is part of a longer one (see findLead), so only an act
   of exactly that name will do, and one with a following: two words out of
   five could be anyone. */
async function findArtist(artist,lead){
  const r=await jsonp("https://api.deezer.com/search/artist?limit=8&q="+encodeURIComponent(artist)+"&output=jsonp&callback=");
  if(!r||r.error)return null;
  const a=nameKey(artist);
  const picture=x=>x.picture_big&&!/\/artist\/\//.test(x.picture_big)?x.picture_big:"";   // an empty slot there means no picture
  const byFans=(x,y)=>(y.nb_fan||0)-(x.nb_fan||0);
  const list=(r.data||[]).filter(x=>x&&x.name);
  const same=list.filter(x=>either((p,q)=>nameKey(p)===nameKey(q),artist,x.name)).sort(byFans)[0];
  if(lead)return same&&(same.nb_fan||0)>=5000?{name:same.name,picture:picture(same),guessed:true}:"";
  if(same)return {name:same.name,picture:picture(same),guessed:false};
  /* A guess has to earn it: a name long enough to judge, at most one slip per
     five letters, and an act with a following, not some stranger with a similar name. */
  if(a.length<6)return "";
  const near=list.map(x=>({x:x,d:slips(a,nameKey(x.name))}))
    .filter(c=>c.d<=Math.floor(a.length/5)&&(c.x.nb_fan||0)>=1000)
    .sort((p,q)=>p.d-q.d||byFans(p.x,q.x))[0];
  return near?{name:near.x.name,picture:picture(near.x),guessed:true}:"";
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
/* A double bill ("Alice In Chains Pear Jam", "Bryan Adams Stevie Vann") is
   nobody's name. The act billed first is found by taking words off the end
   until what is left is somebody. */
async function findLead(artist){
  const w=artist.split(" ");
  for(let n=w.length-1;n>=2;n--){
    await pause(220);
    const who=await findArtist(w.slice(0,n).join(" "),true);
    if(who||who===null)return who;
  }
  return "";
}
/* the song's own sleeve, from whichever service has it: a url, "" or null (no answer).
   With `read`, the title may turn out to hold the act as well as the song, and
   read(names) is told when the sleeve was found by reading it so. A second go
   under another name for the artist comes without: that has been tried. */
async function findSleeve(artist,title,read){
  const tw=title.split(" "),aw=artist.split(" ");
  /* What to ask for, most exact first. Tags often carry extra words after the
     name ("Everybody Hurts R.E.M. cover"), so the title is also tried a word or
     two shorter; a double-billed artist is also tried by its first name alone.
     Last of all the title with no artist, in case it holds the act as well
     (see holdsBoth). */
  const terms=[artist+" "+title];
  for(let cut=1;cut<=2&&tw.length-cut>=1;cut++)terms.push(artist+" "+tw.slice(0,tw.length-cut).join(" "));
  if(aw.length>2)terms.push(aw.slice(0,2).join(" ")+" "+title);
  if(read&&tw.length>1)terms.push(title);
  const fits=(a,s)=>{
    if(agrees(artist,title,a,s))return true;
    const names=read?holdsBoth(title,a,s):null;
    if(names)read(names);
    return !!names;
  };
  let unanswered=false;
  const down=SOURCES.map(()=>false);
  for(const term of terms){
    for(let i=0;i<SOURCES.length;i++){
      if(down[i])continue;
      const u=await SOURCES[i](term,fits);
      if(u)return u;
      if(u===null){down[i]=true;unanswered=true;}
      await pause(220);                    // stay well inside both services' limits
    }
  }
  return unanswered?null:"";
}
/* In order: the song's sleeve under the name as tagged; then, if the name looks
   misspelt or is a double bill, the song's sleeve under the name it most likely
   means; then a picture of that artist. Gives {u,sure}: a cover url or "", and
   whether that is the last word. A service that did not answer leaves it open:
   the sleeve may still be out there, so the artist stands in for now and the
   song is looked up again next time. With `names`, the sleeve was found by
   reading the title as act and song together (see holdsBoth). */
async function artLookup(t){
  /* "(Original Version)", "[Remastered]", "feat. X" only hurt the search */
  const title=bare(t.title).replace(/\s+(feat|ft)\.? .*$/i,"").trim()||t.title;
  let sure=true,names=null;
  let u=await findSleeve(t.artist,title,n=>{names=n;});
  if(u)return {u:u,sure:true,names:names};
  if(u===null)sure=false;
  let who=await findArtist(t.artist);
  if(who==="")who=await findLead(t.artist);
  if(!who)return {u:"",sure:sure&&who!==null};   // nobody fits, or no answer
  if(who.guessed){
    u=await findSleeve(who.name,title);
    if(u)return {u:u,sure:true};
    if(u===null)sure=false;
  }
  return {u:who.picture,sure:sure};
}
/* art(text,size,fn): fn(url) with a square cover of that pixel size, or fn(null) */
function art(text,size,fn){
  const sized=u=>u.replace(/\/\d+x\d+bb\./,"/"+size+"x"+size+"bb.")                       // iTunes
                  .replace(/\/\d+x\d+(-\d+-\d+-\d+-\d+\.jpg)$/,"/"+size+"x"+size+"$1");     // Deezer
  const give=u=>fn(u?sized(u):null);
  if(Object.prototype.hasOwnProperty.call(artStore,text)){give(artStore[text]);return;}
  const t=split(text);
  if(!t.artist){give(null);return;}
  if(!artWait[text]){
    artWait[text]=artQueue=artQueue.then(()=>artLookup(t)).then(r=>{
      delete artWait[text];
      /* a tag read differently goes by what it says from here on, under the same cover */
      const song=r.names?tidy(r.names.artist+" - "+r.names.title):"";
      if(r.sure){                        // no answer is not a miss: try again next time
        artStore[text]=r.u;
        if(song)artStore[song]=r.u;
        const keys=Object.keys(artStore);
        keys.slice(0,Math.max(0,keys.length-80)).forEach(k=>delete artStore[k]);
        try{localStorage.setItem(ART,JSON.stringify(artStore));}catch(e){}
      }
      if(song)reread(text,song);
      return r.u;
    });
  }
  artWait[text].then(give);
}

const FAKE=["Queens of the Stone Age - No One Knows","The Smashing Pumpkins - Bullet with Butterfly Wings",
            "U2 - One","PJ Harvey - Rid of Me","Rage Against the Machine - Killing in the Name","Yeah Yeah Yeahs - Maps"];
/* the skip test's running order: long names and short, one with no sleeve
   anywhere (it gets the artist's picture), one tagged wrong, one nobody has,
   and one with the act in the title (it is renamed once it has been looked up) */
const SKIPS=["Deep Purple - Black Night","Michael Jackson - Remember The Time","U2 - One",
             "The Smashing Pumpkins - Bullet with Butterfly Wings","L.A. Guns - Cold Gin",
             "Queens of the Stone Age - No One Knows","B.Tyler - Total Eclipse ot the Heart",
             "Soul Asylum - 99%","Rage Against the Machine - Killing in the Name",
             "The House Band - A Song With No Cover","I_m_in_love - Counting_Crows_Accidentally_In_Love_"];
let fakeI=0;
function begin(){
  if(DEMO||SKIP){
    const list=SKIP?SKIPS:FAKE;
    const secs=Math.max(1,parseFloat(Q.get(SKIP?"skiptest":"demo"))||(SKIP?5:12));
    /* look every cover up ahead of time, so a change is not kept waiting for one */
    if(SKIP)list.forEach(x=>art(tidy(x),600,()=>{}));
    const next=()=>setTrack(tidy(list[fakeI++%list.length]));
    next();setInterval(next,secs*1000);
  }else{seed();poll();setInterval(poll,20000);}
}

/* ---------------- keys + OS media controls ---------------- */
document.addEventListener("keydown",e=>{
  if(e.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;
  if(e===unblockEvent)return;                  // that key press was the one that started the sound
  if(e.code==="Space"){e.preventDefault();if(radio.keepAlive)setMuted(!muted);else toggle();}
  else if(e.key==="ArrowUp"){e.preventDefault();setVolume(vol+.05);}
  else if(e.key==="ArrowDown"){e.preventDefault();setVolume(vol-.05);}
});
if("mediaSession"in navigator){
  navigator.mediaSession.setActionHandler("play",start);
  navigator.mediaSession.setActionHandler("pause",stop);
}

const radio={
  NB:NB,FREQS:FREQS,LABELS:LABELS,PRESETS:PRESETS,demo:DEMO,
  state:"off",track:null,volume:vol,eq:eq,muted:false,keepAlive:false,
  on:on,start:start,stop:stop,toggle:toggle,autostart:autostart,setMuted:setMuted,sample:sample,
  setVolume:setVolume,setBand:setBand,setEq:setEq,setPreset:setPreset,presetName:presetName,played:played,art:art,
};
window.radio=radio;
document.documentElement.dataset.air="off";
/* let the page subscribe before the first track lands */
setTimeout(begin,0);
})();

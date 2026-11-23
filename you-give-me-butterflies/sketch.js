// You give me Butterflies — Firebase 연결 버전
// 화면: 이름 쓰기 → 내 꽃밭 → (편지 아이콘) 누구에게? → 손으로 나비 만들어 보내기
//       꽃밭에 날아온 나비를 누르면 → 손바닥을 펴서 받기 → 양쪽 꽃밭에 꽃
//
// 키보드 (테스트용)
//   H : 디버그 표시 (손가락 비율, 마이크 볼륨, 날짜)
//   N : 이 기기만 하루 뒤로 (주소 뒤에 ?day=1 을 붙여도 같음)

function IS_MOBILE() { return /Android|iPhone|iPad/i.test(navigator.userAgent); }

// ───────── 설정값 (직접 손대보며 조정) ─────────
const CFG = {
  EXTENDED: 1.55,       // 손가락 끝~손목 거리 / 손 크기 가 이 값보다 크면 "펴짐"
  CURLED: 1.25,         // 이 값보다 작으면 "접힘"
  STABLE_FRAMES: IS_MOBILE() ? 3 : 6, // 같은 제스처가 이 프레임 이상 이어져야 인정
  CRAWL_TIME: 1500,     // 애벌레가 손가락 끝까지 기어오르는 시간(ms)
  COCOON_MIN: 3000,     // 이보다 짧게 쥐면 애벌레로 돌아감
  COCOON_FULL: 8000,    // 고치가 다 자라는 시간 (채도 최대)
  BLOW_LEVEL: 0.12,     // 마이크 볼륨이 이 값을 넘으면 "후"
  BLOW_FRAMES: 8,       // 이 프레임 이상 이어져야 "후"로 인정
  RECEIVE_HOLD: 700,    // 받을 때 손바닥을 이만큼 펴고 있어야 함(ms)
  DAY_START_HOUR: 4     // 새벽 4시에 날짜가 바뀜
};

const BANDS = [ // 시간대 색 (hue)
  { from: 5, to: 11, hue: 50 },   // 아침: 노랑
  { from: 11, to: 17, hue: 110 }, // 낮: 초록
  { from: 17, to: 21, hue: 320 }, // 저녁: 분홍
  { from: 21, to: 29, hue: 230 }  // 새벽: 남색 (21시~다음날 5시)
];
const FLOWER_NAMES = ["", "클로버", "나팔꽃", "튤립", "데이지", "코스모스", "수국", "해바라기"];
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

// ───────── 전역 ─────────
let video, handPose, ctx;
let hands = [];
let analyser = null, micData = null, micLevel = 0;
let debug = false;
let dayOffset = Number(new URLSearchParams(location.search).get("day") || 0);

let db = null, users = {}, weeks = {}, weeksLoaded = false;
let me = null;               // { id, name, hue }

let mode = "join";           // join, garden, send, receive
let sendTo = null;           // 보낼 친구 id
let sendState = "WAIT", stateStart = 0, cocoonHeld = 0, todayDay = null, flyFrom = null, blowCount = 0;
let recvRec = null, recvOpenSince = 0, recvLandAt = 0, recvDone = false;
let gesture = "none", rawGesture = "none", gestureCount = 0;
let lastPalm = null;

let bornAt = {}, gardenReady = false; // 꽃 피는 애니메이션
let tip = null;                       // 꽃 기록 말풍선
let hitFlowers = [], hitButterflies = [];

// ───────── 시작 ─────────
async function setup() {
  createCanvas(windowWidth, windowHeight);
  ctx = drawingContext;

  bindUI();
  initFirebase();

  // 주소 뒤에 ?reset 을 붙이면 이 기기의 이름을 지우고 처음부터
  if (new URLSearchParams(location.search).has("reset")) { try { localStorage.removeItem("ygmb_me"); } catch (e) {} }
  me = loadMe();
  if (me) enterGarden(); else showJoin();

  handPose = await ml5.handPose({ flipped: true, maxHands: 1 });
  if (video) handPose.detectStart(video, gotHands); // 모델이 늦게 준비된 경우
}

function gotHands(r) { hands = r; }

// ───────── 카메라: 보내기/받기 화면에서만 켜기 ─────────
function startCamera() {
  if (video) return;
  // 앞 카메라. 크기는 카메라가 주는 대로
  video = createCapture(
    { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { flipped: true }
  );
  video.hide();
  if (handPose) handPose.detectStart(video, gotHands);
}

function stopCamera() {
  if (!video) return;
  try { if (handPose) handPose.detectStop(); } catch (e) {}
  try {
    const st = video.elt && video.elt.srcObject;
    if (st) st.getTracks().forEach((t) => t.stop());
    video.remove();
  } catch (e) {}
  video = null;
  hands = [];
  gesture = rawGesture = "none";
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// ───────── Firebase ─────────
function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    db.ref("users").on("value", (s) => {
      users = s.val() || {};
      if (document.getElementById("picker").classList.contains("show")) renderPicker();
    });
    db.ref("weeks").on("value", (s) => {
      weeks = s.val() || {};
      weeksLoaded = true;
    });
  } catch (e) {
    console.error(e);
    toast("Firebase 설정을 확인해주세요 (firebase-config.js)");
  }
}

const pairKey = (from, to) => from + "__" + to;
const daysOf = (r) => (r && r.days ? Object.values(r.days) : []);
const nameOf = (id) => (users[id] ? users[id].name : "누군가");
const hueOf = (id) => (users[id] ? users[id].hue : 40);

function rec(from, to, wk = weekId()) { return (weeks[wk] || {})[pairKey(from, to)] || null; }

function sendStatus(to) {
  const r = rec(me.id, to);
  if (r && r.received) return "received";
  if (daysOf(r).some((d) => d.date === dayKey())) return "today";
  return "ok";
}

function incoming() { // 이번 주 나에게 온, 아직 받지 않은 나비들
  const out = [], wk = weeks[weekId()] || {};
  for (const k in wk) {
    const r = wk[k];
    if (r.to === me.id && !r.received && daysOf(r).length) out.push({ ...r, key: weekId() + "/" + k });
  }
  return out;
}

function myFlowers() { // 내가 주고받아서 핀 꽃 전부
  const out = [];
  for (const wk in weeks) for (const k in weeks[wk]) {
    const r = weeks[wk][k];
    if (r.received && (r.from === me.id || r.to === me.id)) out.push({ ...r, key: wk + "/" + k });
  }
  out.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
  return out;
}

function writeSend(to, day) {
  const ref = db.ref(`weeks/${weekId()}/${pairKey(me.id, to)}`);
  return ref.transaction((cur) => {
    cur = cur || { from: me.id, to: to, days: [] };
    const ds = daysOf(cur);
    if (cur.received || ds.some((d) => d.date === day.date)) return; // 오늘 이미 보냈거나, 이번 주는 끝남
    ds.push(day);
    cur.days = ds;
    return cur;
  });
}

function writeReceive(r) {
  return db.ref("weeks/" + r.key).transaction((cur) => {
    if (!cur || cur.received) return;
    cur.received = dayKey();
    cur.receivedAt = Date.now();
    return cur;
  });
}

// ───────── 나 (이 기기에 저장) ─────────
function loadMe() { try { return JSON.parse(localStorage.getItem("ygmb_me") || "null"); } catch (e) { return null; } }
function saveMe() { try { localStorage.setItem("ygmb_me", JSON.stringify(me)); } catch (e) {} }

function join() {
  const name = document.getElementById("nameInput").value.trim();
  if (!name) { toast("이름을 써주세요"); return; }
  me = { id: "u" + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name, hue: Math.floor(Math.random() * 360), joined: Date.now() };
  saveMe();
  startMic();
  enterGarden();
}

// ───────── 화면 전환 ─────────
function show(id, on) { document.getElementById(id).classList.toggle("show", on); }
function showJoin() { mode = "join"; show("join", true); setButtons(); }

function enterGarden() {
  mode = "garden";
  stopCamera();
  show("join", false); show("picker", false);
  if (db && me) db.ref("users/" + me.id).set({ name: me.name, hue: me.hue, joined: me.joined || Date.now() });
  setButtons();
}

function openPicker() {
  startMic();
  renderPicker();
  show("picker", true);
}

function renderPicker() {
  const list = document.getElementById("pickList");
  const others = Object.entries(users).filter(([id]) => id !== me.id).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0));
  if (!others.length) {
    list.innerHTML = `<p style="margin:0">아직 다른 사람이 없어요.<br>다른 기기에서 이름을 쓰고 들어와 주세요.</p>`;
    return;
  }
  list.innerHTML = others.map(([id, u]) => {
    const st = sendStatus(id);
    const note = st === "today" ? "오늘 보냈어요" : st === "received" ? "이번 주는 받았어요" : "";
    return `<button data-id="${id}" ${st === "ok" ? "" : "disabled"}>
      <span><span class="dot" style="background:hsl(${u.hue},80%,62%)"></span>${escapeHTML(u.name)}</span><small>${note}</small></button>`;
  }).join("");
}

function startSend(to) {
  show("picker", false);
  sendTo = to;
  mode = "send";
  startCamera();
  todayDay = null;
  setSendState("WAIT");
  setButtons();
}

function startReceive(r) {
  startMic();
  recvRec = r; recvOpenSince = 0; recvLandAt = 0; recvDone = false;
  mode = "receive";
  startCamera();
  tip = null;
  setButtons();
}

function setButtons() {
  document.getElementById("mail").style.display = mode === "garden" ? "flex" : "none";
  document.getElementById("back").style.display = mode === "send" || mode === "receive" ? "block" : "none";
}

function bindUI() {
  document.getElementById("joinBtn").onclick = join;
  document.getElementById("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  document.getElementById("mail").onclick = openPicker;
  document.getElementById("pickCancel").onclick = () => show("picker", false);
  document.getElementById("pickList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b && !b.disabled) startSend(b.dataset.id);
  });
  document.getElementById("back").onclick = enterGarden;

  // 캔버스가 바뀌어도 동작하도록 문서 전체에서 받음 (버튼·창 위의 클릭은 제외)
  const onUI = (e) => e.target.closest && e.target.closest("button, input, .overlay");
  document.addEventListener("pointerdown", (e) => { if (!onUI(e)) canvasTap(e.clientX, e.clientY, true); });
  document.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && !onUI(e)) canvasTap(e.clientX, e.clientY, false); });

  window.addEventListener("keydown", (e) => {
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    if (e.key === "h" || e.key === "H") debug = !debug;
    if (e.key === "n" || e.key === "N") { dayOffset++; toast("이 기기 날짜: " + dayLabel()); }
  });
}

function canvasTap(x, y, isTap) {
  if (mode !== "garden") return;
  if (isTap) {
    const b = hitButterflies.find((o) => Math.hypot(o.x - x, o.y - y) < o.r);
    if (b) { startReceive(b.rec); return; }
  }
  const f = hitFlowers.find((o) => Math.hypot(o.x - x, o.y - y) < o.r);
  tip = f || null;
}

// ───────── 마이크 (p5.sound 없이) ─────────
async function startMic() {
  if (analyser) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext();
    await ac.resume();
    analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    micData = new Float32Array(analyser.fftSize);
    ac.createMediaStreamSource(stream).connect(analyser);
  } catch (e) { console.log("마이크를 켤 수 없어요:", e); }
}

function getMicLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(micData);
  let s = 0;
  for (const v of micData) s += v * v;
  return Math.sqrt(s / micData.length);
}

// ───────── 메인 루프 ─────────
function draw() {
  const W = width, H = height;
  ctx.fillStyle = "#0f1c18";
  ctx.fillRect(0, 0, W, H);
  micLevel = getMicLevel();

  const hand = video && hands.length ? toScreen(hands[0]) : null;
  updateGesture(hand);
  if (hand) lastPalm = palmCenter(hand);

  if (mode === "garden" || mode === "join") drawGarden(W, H);
  else if (mode === "send") { drawVideo(); updateSend(hand); drawSend(hand, W, H); }
  else if (mode === "receive") { drawVideo(); updateReceive(hand, W, H); }

  if (debug) drawDebug(hand);
}

// ───────── 꽃밭 ─────────
function drawGarden(W, H) {
  const gy = H * 0.78;
  // 별
  ctx.fillStyle = "rgba(255,255,255,.05)";
  for (let i = 0; i < 60; i++) ctx.fillRect((i * 97) % W, (i * 53) % Math.max(gy - 30, 1), 1.6, 1.6);
  // 땅
  ctx.fillStyle = "#17302a";
  ctx.beginPath(); ctx.moveTo(0, gy);
  for (let x = 0; x <= W + 20; x += 20) ctx.lineTo(Math.min(x, W), gy + Math.sin(Math.min(x, W) * 0.02) * 6);
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();

  if (!me) return;

  // 제목
  ctx.fillStyle = "#e8efe9"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = "26px 'Gowun Dodum', 'Noto Sans KR', sans-serif";
  ctx.fillText(me.name + "의 꽃밭", 22, 46);
  ctx.font = "13px 'Noto Sans KR', sans-serif"; ctx.fillStyle = "#9db0a8";
  ctx.fillText(dayLabel(), 22, 68);

  // 꽃
  const flowers = myFlowers();
  if (weeksLoaded && !gardenReady) { flowers.forEach((f) => (bornAt[f.key] = -1e9)); gardenReady = true; }
  const k = Math.min(W, H) / 420;
  const n = flowers.length;
  const perRow = Math.max(1, Math.floor((W - 40) / (70 * k)));
  hitFlowers = [];
  flowers.forEach((f, i) => {
    if (!(f.key in bornAt)) bornAt[f.key] = millis();
    const row = Math.floor(i / perRow), col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    const gap = Math.min(70 * k, (W - 60) / inRow);
    const xx = W / 2 + (col - (inRow - 1) / 2) * gap;
    const y = gy + 6 + row * 34 * k + ((i * 37) % 3 - 1) * 4;
    const ds = daysOf(f);
    const age = constrain((millis() - bornAt[f.key]) / 900, 0, 1);
    const sc = 1.1 * k * easeOut(age) * (1 - row * 0.08);
    if (sc > 0.01) drawFlower(xx, y, ds.length, ds[0].hue, ds[0].sat, sc);
    hitFlowers.push({ x: xx, y: y - 56 * 1.1 * k, r: 26 * k, f });
  });

  // 날아온 나비
  const inc = incoming();
  hitButterflies = [];
  const T = millis() * 0.001;
  inc.forEach((r, i) => {
    const ph = i * 2.1;
    const bx = W / 2 + Math.sin(T * 0.6 + ph) * W * 0.3;
    const by = H * 0.36 + Math.sin(T * 1.2 + ph) * H * 0.09 + i * 20;
    const s = 42 * k * 1.2;
    drawButterfly(bx, by, s, daysOf(r), flapAt(4, ph), hueOf(r.from));
    hitButterflies.push({ x: bx, y: by, r: Math.max(s * 1.4, 60), rec: r });
  });

  // 안내
  ctx.textAlign = "center"; ctx.font = "14px 'Noto Sans KR', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.6)";
  if (inc.length) ctx.fillText("날아온 나비를 눌러서 받아주세요", W / 2, H * 0.14 + 20);
  else if (!n) ctx.fillText("아직 핀 꽃이 없어요. 편지 아이콘을 눌러 나비를 보내보세요", W / 2, gy + (H - gy) / 2);

  // 꽃 기록 말풍선
  if (tip) drawTip(tip, W);
}

function drawTip(h, W) {
  const f = h.f, ds = daysOf(f);
  const lines = [
    `${nameOf(f.from)} → ${nameOf(f.to)} · ${FLOWER_NAMES[ds.length]}`,
    "보낸 날: " + fmtList(ds.map((d) => d.date)),
    "받은 날: " + f.received.split("-").join(".")
  ];
  ctx.font = "13px 'Noto Sans KR', sans-serif";
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24, hh = lines.length * 20 + 14;
  const x = constrain(h.x - w / 2, 8, W - w - 8), y = Math.max(8, h.y - h.r - hh - 6);
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.roundRect(x, y, w, hh, 10); ctx.fill();
  ctx.fillStyle = "#14231e"; ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, x + 12, y + 24 + i * 20));
}

// ───────── 보내기 ─────────
function setSendState(s) { sendState = s; stateStart = millis(); }
function elapsed() { return millis() - stateStart; }

function updateSend(hand) {
  switch (sendState) {
    case "WAIT":
      if (hand && gesture === "point") setSendState("CATERPILLAR");
      break;
    case "CATERPILLAR":
      if (!hand) { setSendState("WAIT"); break; }
      if (elapsed() > CFG.CRAWL_TIME && gesture === "fist") setSendState("COCOON");
      break;
    case "COCOON":
      if (!hand) break;
      cocoonHeld = elapsed();
      if (gesture === "open") {
        if (cocoonHeld < CFG.COCOON_MIN) setSendState("CATERPILLAR");
        else {
          const held = Math.min(cocoonHeld, CFG.COCOON_FULL);
          todayDay = { date: dayKey(), hue: timeHue(), sat: Math.round(map(held, CFG.COCOON_MIN, CFG.COCOON_FULL, 30, 100, true)) };
          blowCount = 0;
          setSendState("BUTTERFLY");
        }
      }
      break;
    case "BUTTERFLY":
      if (micLevel > CFG.BLOW_LEVEL) blowCount++; else blowCount = Math.max(0, blowCount - 1);
      if (blowCount >= CFG.BLOW_FRAMES) { flyFrom = lastPalm || { x: width / 2, y: height / 2 }; setSendState("FLYING"); }
      break;
    case "FLYING":
      if (elapsed() > 2300) {
        setSendState("SENDING");
        writeSend(sendTo, todayDay).then((res) => {
          toast(res.committed ? `나비가 ${nameOf(sendTo)}에게 날아갔어요` : "오늘은 이미 보냈거나, 이번 주는 끝났어요");
          enterGarden();
        }).catch((e) => { console.error(e); toast("보내지 못했어요. 인터넷을 확인해주세요"); enterGarden(); });
      }
      break;
  }
}

function drawSend(hand, W, H) {
  const k = Math.min(W, H) / 420;
  const prev = daysOf(rec(me.id, sendTo)); // 이번 주에 이미 보낸 날들 (점박이)
  ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.roundRect(W / 2 - 90, 14, 180, 38, 19); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "15px 'Noto Sans KR', sans-serif";
  ctx.fillText(nameOf(sendTo) + "에게", W / 2, 38);

  switch (sendState) {
    case "WAIT":
      guide("검지 하나를 내밀어 애벌레를 데려오세요"); break;
    case "CATERPILLAR":
      if (hand) drawCaterpillar(hand.keypoints[5], hand.keypoints[8], constrain(elapsed() / CFG.CRAWL_TIME, 0, 1), k);
      guide(elapsed() > CFG.CRAWL_TIME ? "손을 감싸 쥐어 애벌레를 품어주세요" : "애벌레가 올라오고 있어요"); break;
    case "COCOON": {
      const t = constrain(cocoonHeld / CFG.COCOON_FULL, 0, 1);
      if (lastPalm) drawGlow(lastPalm, t, timeHue(), k, cocoonHeld - CFG.COCOON_FULL);
      guide(cocoonHeld >= CFG.COCOON_FULL ? "이제 손을 펴도 돼요"
        : cocoonHeld >= CFG.COCOON_MIN ? "조금 더 품으면 더 진해져요. 펴도 괜찮아요"
        : nameOf(sendTo) + eulReul(nameOf(sendTo)) + " 떠올리며 잠시 품어주세요");
      break;
    }
    case "BUTTERFLY": {
      const g = easeOut(constrain(elapsed() / 800, 0, 1));
      const p = lastPalm || { x: W / 2, y: H / 2 };
      drawButterfly(p.x, p.y - 60 * k * g, 56 * k * g, prev.concat([todayDay]), flapAt(5), me.hue);
      drawBlowMeter(W, H);
      guide("\"후\" 불어서 날려 보내세요"); break;
    }
    case "FLYING":
    case "SENDING": {
      const f = constrain(elapsed() / 2300, 0, 1), e = f * f;
      const x = lerp(flyFrom.x, W + 100, e) + Math.sin(f * 16) * 30 * (1 - e);
      const y = lerp(flyFrom.y - 40, -100, e) + Math.cos(f * 12) * 20;
      drawButterfly(x, y, 56 * k * (1 - e * 0.4), prev.concat([todayDay]), flapAt(14), me.hue);
      break;
    }
  }
}

// ───────── 받기 ─────────
function updateReceive(hand, W, H) {
  const k = Math.min(W, H) / 420;
  const r = recvRec, ds = daysOf(r);
  const T = millis() * 0.001;
  const hover = { x: W / 2 + Math.sin(T * 0.8) * W * 0.15, y: H * 0.25 + Math.sin(T * 1.4) * 20 };

  if (!recvLandAt) {
    if (hand && gesture === "open") {
      if (!recvOpenSince) recvOpenSince = millis();
      if (millis() - recvOpenSince > CFG.RECEIVE_HOLD) recvLandAt = millis();
    } else recvOpenSince = 0;
    drawButterfly(hover.x, hover.y, 50 * k, ds, flapAt(5), hueOf(r.from));
    guide(nameOf(r.from) + "의 나비예요. 손바닥을 펴서 내밀어 주세요");
    return;
  }

  const f = constrain((millis() - recvLandAt) / 1400, 0, 1), e = easeOut(f);
  const p = lastPalm || { x: W / 2, y: H * 0.6 };
  drawButterfly(lerp(hover.x, p.x, e), lerp(hover.y, p.y - 40 * k, e), 50 * k, ds, flapAt(lerp(6, 1, e)), hueOf(r.from));
  guide("나비가 손바닥에 내려앉았어요");
  if (f >= 1 && !recvDone) {
    recvDone = true;
    writeReceive(r).then(() => {
      toast(`${FLOWER_NAMES[ds.length]}${josa(FLOWER_NAMES[ds.length])} 피었어요`);
      setTimeout(enterGarden, 600);
    }).catch((e2) => { console.error(e2); toast("받지 못했어요. 인터넷을 확인해주세요"); enterGarden(); });
  }
}

// ───────── 그리기 도구 (캔버스 2D) ─────────
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
function flapAt(speed, ph = 0) { return 0.3 + 0.7 * Math.abs(Math.sin(millis() * 0.001 * speed + ph)); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function drawVideo() {
  if (!video) return;
  const v = videoRect();
  ctx.save(); ctx.globalAlpha = 0.6;
  image(video, v.x, v.y, v.w, v.h);
  ctx.restore();
}

// days: [{hue, sat}, ...] 첫날 = 날개 바탕, 둘째 날부터 = 좌우 점 / edgeHue = 보낸 사람 색
function drawButterfly(x, y, size, days, flap, edgeHue) {
  if (!days.length || size < 1) return;
  const base = days[0], edge = hsl(edgeHue, 80, 62);
  const spots = [[0.55, -0.45], [0.35, -0.22], [0.78, -0.2], [0.45, 0.3], [0.25, 0.47], [0.62, 0.5]];
  ctx.save(); ctx.translate(x, y);
  for (const side of [-1, 1]) {
    ctx.save(); ctx.scale(side * flap, 1);
    ctx.lineWidth = 2 / Math.max(flap, 0.3); ctx.strokeStyle = edge;
    ctx.fillStyle = hsl(base.hue, base.sat, 64);
    ctx.beginPath(); ctx.ellipse(size * 0.5, -size * 0.3, size * 0.5, size * 0.36, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hsl(base.hue, base.sat * 0.85, 54);
    ctx.beginPath(); ctx.ellipse(size * 0.38, size * 0.35, size * 0.34, size * 0.27, 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (let i = 1; i < days.length && i <= spots.length; i++) {
      const d = days[i], s = spots[i - 1];
      ctx.fillStyle = hsl(d.hue, d.sat, 72); ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(s[0] * size, s[1] * size, size * 0.085, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.fillStyle = "#1d2a26";
  ctx.beginPath(); ctx.ellipse(0, 0, size * 0.07, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = edge; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -size * 0.36); ctx.lineTo(-size * 0.22, -size * 0.72); ctx.moveTo(0, -size * 0.36); ctx.lineTo(size * 0.22, -size * 0.72); ctx.stroke();
  ctx.fillStyle = edge;
  ctx.beginPath(); ctx.arc(-size * 0.22, -size * 0.72, size * 0.04, 0, 7); ctx.arc(size * 0.22, -size * 0.72, size * 0.04, 0, 7); ctx.fill();
  ctx.restore();
}

function drawCaterpillar(base, tip, p, k) {
  const head = { x: lerp(base.x, tip.x, p), y: lerp(base.y, tip.y, p) };
  const ang = Math.atan2(tip.y - base.y, tip.x - base.x);
  for (let i = 5; i >= 0; i--) {
    const wob = Math.sin(millis() * 0.012 - i * 0.9) * 3 * k;
    const x = head.x - Math.cos(ang) * 12 * k * i + Math.cos(ang + Math.PI / 2) * wob;
    const y = head.y - Math.sin(ang) * 12 * k * i + Math.sin(ang + Math.PI / 2) * wob;
    ctx.fillStyle = hsl(95, 50, i === 0 ? 62 : 55);
    ctx.beginPath(); ctx.arc(x, y, (i === 0 ? 10 : 8.5) * k, 0, 7); ctx.fill();
  }
  ctx.fillStyle = "#14231e";
  ctx.beginPath(); ctx.arc(head.x - 3 * k, head.y - 2 * k, 2 * k, 0, 7); ctx.arc(head.x + 3 * k, head.y - 2 * k, 2 * k, 0, 7); ctx.fill();
}

function drawGlow(c, t, hue, k, sinceFull) {
  const pulse = 1 + Math.sin(millis() * (0.003 + t * 0.006)) * 0.15 * (0.3 + t);
  const r = lerp(30, 140, t) * pulse * k;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (let i = 6; i > 0; i--) {
    ctx.fillStyle = hsl(hue, lerp(0, 75, t), 70, 0.06 + t * 0.05);
    ctx.beginPath(); ctx.arc(c.x, c.y, r * i / 3, 0, 7); ctx.fill();
  }
  if (sinceFull > 0 && sinceFull < 450) {
    const f = sinceFull / 450;
    ctx.fillStyle = hsl(hue, 30, 90, 0.4 * (1 - f));
    ctx.beginPath(); ctx.arc(c.x, c.y, r + r * 2.5 * f, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function drawFlower(x, gy, type, h, sat, s) {
  const top = { x, y: gy - 56 * s };
  ctx.save();
  ctx.strokeStyle = hsl(130, 30, 42); ctx.lineWidth = 2.5 * s;
  ctx.beginPath(); ctx.moveTo(x, gy); ctx.quadraticCurveTo(x - 6 * s, gy - 28 * s, top.x, top.y); ctx.stroke();
  ctx.fillStyle = hsl(130, 32, 40);
  ctx.beginPath(); ctx.ellipse(x - 9 * s, gy - 22 * s, 9 * s, 4 * s, 0.6, 0, 7); ctx.fill();
  ctx.translate(top.x, top.y);
  const petal = (n, rx, ry, dist, l, rot = 0) => {
    ctx.fillStyle = hsl(h, sat, l);
    for (let i = 0; i < n; i++) {
      const a = rot + i * Math.PI * 2 / n;
      ctx.beginPath(); ctx.ellipse(Math.cos(a) * dist, Math.sin(a) * dist, rx, ry, a, 0, 7); ctx.fill();
    }
  };
  const center = (r, l) => { ctx.fillStyle = hsl(h, Math.min(100, sat + 10), l); ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); };
  switch (Math.min(7, Math.max(1, type))) {
    case 1: // 클로버
      for (let i = 0; i < 3; i++) {
        ctx.save(); ctx.rotate(-Math.PI / 2 + i * Math.PI * 2 / 3); ctx.fillStyle = hsl(h, sat, 60);
        ctx.beginPath(); ctx.arc(9 * s, -4 * s, 6 * s, 0, 7); ctx.arc(9 * s, 4 * s, 6 * s, 0, 7); ctx.fill(); ctx.restore();
      }
      break;
    case 2: petal(5, 9 * s, 8 * s, 8 * s, 62); center(7 * s, 85); center(3 * s, 45); break; // 나팔꽃
    case 3: // 튤립
      ctx.fillStyle = hsl(h, sat, 56);
      ctx.beginPath(); ctx.moveTo(-12 * s, -2 * s); ctx.lineTo(-12 * s, -18 * s); ctx.lineTo(-5 * s, -10 * s); ctx.lineTo(0, -20 * s);
      ctx.lineTo(5 * s, -10 * s); ctx.lineTo(12 * s, -18 * s); ctx.lineTo(12 * s, -2 * s); ctx.quadraticCurveTo(0, 12 * s, -12 * s, -2 * s); ctx.fill();
      break;
    case 4: petal(16, 9 * s, 2.6 * s, 10 * s, 70); center(5.5 * s, 50); break; // 데이지
    case 5: petal(8, 10 * s, 5 * s, 11 * s, 64, 0.2); center(4.5 * s, 40); break; // 코스모스
    case 6: // 수국
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4, r = Math.sqrt(i) * 6.5 * s;
        ctx.save(); ctx.translate(Math.cos(a) * r, Math.sin(a) * r - 3 * s);
        petal(4, 3.4 * s, 2.4 * s, 3 * s, 58 + (i % 3) * 7, 0.4); ctx.restore();
      }
      break;
    case 7: petal(14, 8 * s, 3.4 * s, 17 * s, 58); petal(14, 7 * s, 3 * s, 13 * s, 68, Math.PI / 14); center(11 * s, 28); break; // 해바라기
  }
  ctx.restore();
}

function guide(msg) {
  ctx.font = "17px 'Noto Sans KR', sans-serif";
  const w = ctx.measureText(msg).width + 44;
  ctx.fillStyle = "rgba(0,0,0,.5)";
  ctx.beginPath(); ctx.roundRect(width / 2 - w / 2, height - 84, w, 44, 22); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(msg, width / 2, height - 62);
  ctx.textBaseline = "alphabetic";
}

function drawBlowMeter(W, H) {
  const w = 160, x = W / 2 - w / 2, y = H - 112;
  ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.beginPath(); ctx.roundRect(x, y, w, 6, 3); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.roundRect(x, y, w * constrain(blowCount / CFG.BLOW_FRAMES, 0, 1), 6, 3); ctx.fill();
}

function drawDebug(hand) {
  ctx.fillStyle = "#fff"; ctx.font = "12px monospace"; ctx.textAlign = "left";
  const lines = [
    "mode " + mode + " / send " + sendState + " / gesture " + gesture + " (raw " + rawGesture + ")",
    "mic " + micLevel.toFixed(3) + " / blow " + blowCount,
    "day " + dayKey() + " / week " + weekId() + " / hue " + timeHue() + " / offset " + dayOffset
  ];
  if (hand) {
    lines.push("ratio 검지 " + fingerRatio(hand, 8).toFixed(2) + " 중지 " + fingerRatio(hand, 12).toFixed(2) +
      " 약지 " + fingerRatio(hand, 16).toFixed(2) + " 소지 " + fingerRatio(hand, 20).toFixed(2));
    ctx.fillStyle = "rgba(255,255,255,.7)";
    for (const p of hand.keypoints) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); }
    ctx.fillStyle = "#fff";
  }
  lines.forEach((l, i) => ctx.fillText(l, 12, height - 150 - (lines.length - i) * 16));
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), 2600);
}

// ───────── 제스처 ─────────
function fingerRatio(hand, tipI) {
  const w = hand.keypoints[0], m = hand.keypoints[9], t = hand.keypoints[tipI];
  return Math.hypot(t.x - w.x, t.y - w.y) / (Math.hypot(m.x - w.x, m.y - w.y) || 1);
}

function classify(hand) {
  const idx = fingerRatio(hand, 8);
  const others = [12, 16, 20].map((i) => fingerRatio(hand, i));
  const ext = others.filter((r) => r > CFG.EXTENDED).length;
  const curl = others.filter((r) => r < CFG.CURLED).length;
  if (idx > CFG.EXTENDED && ext === 0 && curl >= 2) return "point";
  if (idx < CFG.CURLED && curl === 3) return "fist";
  if (idx > CFG.EXTENDED && ext >= 3) return "open";
  return "none";
}

function updateGesture(hand) {
  const g = hand ? classify(hand) : "none";
  if (g === rawGesture) gestureCount++; else { rawGesture = g; gestureCount = 1; }
  if (gestureCount >= CFG.STABLE_FRAMES) gesture = rawGesture;
}

function palmCenter(hand) {
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += hand.keypoints[i].x; y += hand.keypoints[i].y; }
  return { x: x / 5, y: y / 5 };
}

function videoRect() {
  const vw = video.width || 640, vh = video.height || 480;
  const s = Math.max(width / vw, height / vh);
  return { x: (width - vw * s) / 2, y: (height - vh * s) / 2, w: vw * s, h: vh * s, s };
}

function toScreen(hand) {
  const v = videoRect();
  return { keypoints: hand.keypoints.map((p) => ({ x: v.x + p.x * v.s, y: v.y + p.y * v.s })) };
}

// ───────── 시간 ─────────
function nowDate() { return new Date(Date.now() + dayOffset * 86400000); }
function shifted() { return new Date(nowDate().getTime() - CFG.DAY_START_HOUR * 3600000); }
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function dayKey() { return ymd(shifted()); }
function weekId() { const d = shifted(); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return ymd(d); }
function dayLabel() { const d = shifted(); return dayKey().split("-").join(".") + " (" + DOW[d.getDay()] + ")"; }
function timeHue() {
  let h = nowDate().getHours(); if (h < 5) h += 24;
  return (BANDS.find((b) => h >= b.from && h < b.to) || BANDS[3]).hue;
}
function fmtList(list) {
  let out = [], ly = null, lm = null;
  for (const k of list) {
    const [y, m, d] = k.split("-");
    out.push(y !== ly ? `${y}.${m}.${d}` : m !== lm ? `${m}.${d}` : d);
    ly = y; lm = m;
  }
  return out.join(", ");
}

// ───────── 기타 ─────────
function eulReul(word) { const c = word.charCodeAt(word.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? "을" : "를"; }
function josa(word) { const c = word.charCodeAt(word.length - 1); return (c - 0xac00) % 28 ? "이" : "가"; }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

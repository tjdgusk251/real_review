// 찐 맛집 찾기 — 뷰어
// 수집된 JSON만 읽어 동작한다 (실시간 API 호출 없음). 지역은 드롭다운으로 전환.
const REGIONS_URL = "data/regions.json";
const dataUrl = region => `data/restaurants_${region}.json?t=${Date.now()}`;

let map, clusterer, infoWindow;
let allPlaces = [];        // 전체 데이터
let markers = {};          // kakao_id -> marker
let pinnedMarkers = [];    // 클러스터 제외 마커(찐후보/의심) — 항상 지도에 직접 표시
let activeCats = new Set();     // 켜진 카테고리 필터 (비어있으면 전체)
let activeVerdicts = new Set(); // 켜진 판정 필터 (비어있으면 전체)

const VERDICT_ORDER = ["찐후보", "좋음", "과대평가의심", "보통", "표본부족", "정보없음"];
const markerImageCache = {};

// 판정별 마커: 모두 동일한 물방울 핀, 색상만 판정에 따라 다름
function markerImage(verdict, color, count = 1) {
  const key = color + "|" + count;
  if (markerImageCache[key]) return markerImageCache[key];
  const w = 26, h = 36;
  // 겹침 그룹(count>1)은 핀 머리에 개수 표시, 단일은 흰 점
  const head = count > 1
    ? `<circle cx="13" cy="13" r="7.5" fill="white" fill-opacity="0.95"/>
       <text x="13" y="17" text-anchor="middle" fill="${color}"
             font-size="11" font-weight="bold" font-family="sans-serif">${count > 99 ? "99" : count}</text>`
    : `<circle cx="13" cy="13" r="4.5" fill="white" fill-opacity="0.9"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 26 36">
    <path d="M13 1C6.4 1 1 6.4 1 13c0 9 12 22 12 22s12-13 12-22C25 6.4 19.6 1 13 1z"
          fill="${color}" stroke="white" stroke-width="2"/>
    ${head}
  </svg>`;
  markerImageCache[key] = new kakao.maps.MarkerImage(
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
    new kakao.maps.Size(w, h), { offset: new kakao.maps.Point(13, 35) });
  return markerImageCache[key];
}

// 카테고리 대분류 추출: "음식점 > 한식 > 국밥" -> "한식"
function midCat(p) {
  const parts = p.category.split(" > ");
  return parts.length > 1 ? parts[1] : parts[0];
}

// 세부 분류: 가장 구체적인 마지막 단계 ("음식점 > 술집 > 일본식주점" -> "일본식주점")
// 단, 마지막 단계가 브랜드명(가게 이름에 포함: "공차 강남역점" > "공차")이면 한 단계 위를 쓴다.
function fineCat(p) {
  const parts = p.category.split(" > ");
  let i = parts.length - 1;
  if (i > 1 && p.name.includes(parts[i])) i -= 1;
  return parts[i] || midCat(p);
}

let radiusCircle = null;

async function init() {
  // 지역 목록 → 드롭다운
  const regions = await (await fetch(REGIONS_URL + "?t=" + Date.now())).json();  // 캐시 우회
  const sel = document.getElementById("regionSel");
  regions.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r.region;
    opt.textContent = `${r.region} (반경 ${r.radius_m}m)`;
    sel.appendChild(opt);
  });
  sel.onchange = () => loadRegion(sel.value);

  // 지도는 한 번만 생성 (중심은 지역 로드 때 이동)
  map = new kakao.maps.Map(document.getElementById("map"),
                           { center: new kakao.maps.LatLng(37.5, 127.0), level: 4 });
  clusterer = new kakao.maps.MarkerClusterer({
    map, averageCenter: true, minLevel: 3, disableClickZoom: false,
  });
  infoWindow = new kakao.maps.InfoWindow({ zIndex: 10 });

  if (regions.length) loadRegion(regions[0].region);
}

let currentRegion = null;

async function loadRegion(region) {
  const data = await (await fetch(dataUrl(region))).json();
  allPlaces = data.places;
  currentRegion = region;

  document.getElementById("meta").textContent =
    `${data.region} 반경 ${data.radius_m}m · ${data.count}곳 · 수집 ${data.collected_at}`;

  const center = new kakao.maps.LatLng(data.center.lat, data.center.lon);
  map.setCenter(center);
  map.setLevel(4);

  // 수집 반경 원 교체
  if (radiusCircle) radiusCircle.setMap(null);
  radiusCircle = new kakao.maps.Circle({
    map, center, radius: data.radius_m,
    strokeWeight: 2, strokeColor: "#2f6fdd", strokeOpacity: 0.7,
    fillColor: "#2f6fdd", fillOpacity: 0.05,
  });

  // 필터 초기화 후 재구성
  activeCats = new Set();
  activeVerdicts = new Set();
  document.getElementById("verdicts").innerHTML = "";
  document.getElementById("filters").innerHTML = "";
  infoWindow.close();
  openedInfoId = null;
  buildVerdictFilters();
  buildFilters();
  render();
}

function buildVerdictFilters() {
  const counts = {};
  allPlaces.forEach(p => {
    const v = p.analysis ? p.analysis.verdict : "정보없음";
    counts[v] = (counts[v] || 0) + 1;
  });
  // 찐후보·좋음·과대평가의심은 0이어도 표시(없음을 명시), 나머지는 있을 때만
  const ALWAYS = ["찐후보", "좋음", "과대평가의심"];
  const VCOLOR = { "찐후보": "#2b8a3e", "좋음": "#74b816", "보통": "#4c6ef5",
                   "과대평가의심": "#e03131", "표본부족": "#868e96", "정보없음": "#adb5bd" };
  const box = document.getElementById("verdicts");
  VERDICT_ORDER.filter(v => counts[v] || ALWAYS.includes(v)).forEach(v => {
    const n = counts[v] || 0;
    const el = document.createElement("span");
    el.className = "chip";
    if (n === 0) el.style.opacity = "0.4";   // 없음: 흐리게, 클릭 무의미
    el.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${VCOLOR[v]};margin-right:4px"></span>${v} ${n}`;
    el.onclick = () => {
      if (n === 0) return;
      activeVerdicts.has(v) ? activeVerdicts.delete(v) : activeVerdicts.add(v);
      el.classList.toggle("on");
      render();
    };
    box.appendChild(el);
  });
}

function buildFilters() {
  // 많은 순으로 카테고리 칩 생성
  const counts = {};
  allPlaces.forEach(p => { const c = midCat(p); counts[c] = (counts[c] || 0) + 1; });
  const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  const box = document.getElementById("filters");
  cats.forEach(cat => {
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = `${cat} ${counts[cat]}`;
    el.onclick = () => {
      activeCats.has(cat) ? activeCats.delete(cat) : activeCats.add(cat);
      el.classList.toggle("on");
      render();
    };
    box.appendChild(el);
  });
}

function visiblePlaces() {
  return allPlaces.filter(p => {
    if (activeCats.size > 0 && !activeCats.has(midCat(p))) return false;
    if (activeVerdicts.size > 0) {
      const v = p.analysis ? p.analysis.verdict : "정보없음";
      if (!activeVerdicts.has(v)) return false;
    }
    return true;
  });
}

function render() {
  const places = visiblePlaces();
  // 찐후보 필터만 켜져 있으면 찐점수순, 그 외에는 거리순
  const jjinSort = activeVerdicts.size >= 1 &&
    [...activeVerdicts].every(v => v === "찐후보" || v === "좋음");
  if (jjinSort) {
    places.sort((a, b) => (b.analysis?.jjin || 0) - (a.analysis?.jjin || 0));
  } else {
    places.sort((a, b) => a.dist_m - b.dist_m);
  }
  document.getElementById("count").textContent =
    `표시 중: ${places.length}곳 (${jjinSort ? "찐점수순" : "거리순"})`;

  // 마커: 같은 위치(약 11m 격자)의 식당들을 그룹 마커 하나로 합침
  // 그룹 대표 판정(우선순위 최상)의 색 + 개수 배지. 찐후보/의심 포함 그룹은 클러스터 제외.
  clusterer.clear();
  pinnedMarkers.forEach(m => m.setMap(null));
  pinnedMarkers = [];
  markers = {};
  placeGroups = {};
  const zOrder = { "찐후보": 4, "과대평가의심": 4, "좋음": 3, "보통": 2 };
  const V_PRI = { "과대평가의심": 5, "찐후보": 4, "좋음": 3, "보통": 2, "표본부족": 1, "정보없음": 0 };
  const vOf = p => p.analysis ? p.analysis.verdict : "정보없음";
  const groups = {};
  places.forEach(p => {
    const key = p.lat.toFixed(4) + "," + p.lon.toFixed(4);
    (groups[key] = groups[key] || []).push(p);
  });
  const clustered = [];
  Object.values(groups).forEach(grp => {
    grp.sort((a, b) => (V_PRI[vOf(b)] - V_PRI[vOf(a)]) ||
                       ((b.analysis?.jjin || 0) - (a.analysis?.jjin || 0)));
    const rep = grp[0];
    const verdict = vOf(rep);
    const color = rep.analysis ? rep.analysis.color : "#adb5bd";
    const m = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(rep.lat, rep.lon),
      title: grp.length > 1 ? `${rep.name} 외 ${grp.length - 1}곳` : rep.name,
      image: markerImage(verdict, color, grp.length),
      zIndex: zOrder[verdict] || 1,
    });
    kakao.maps.event.addListener(m, "click", () => openGroup(grp, 0));
    grp.forEach(p => { markers[p.kakao_id] = m; placeGroups[p.kakao_id] = grp; });
    if (verdict === "찐후보" || verdict === "과대평가의심") {
      m.setMap(map);
      pinnedMarkers.push(m);
    } else {
      clustered.push(m);
    }
  });
  clusterer.addMarkers(clustered);

  // 사이드바 목록
  const list = document.getElementById("list");
  list.innerHTML = "";
  places.forEach(p => {
    const div = document.createElement("div");
    div.className = "item";
    const dc = p.diningcode;
    const an = p.analysis;
    const badge = an
      ? `<span style="color:${an.color};font-weight:bold">●&nbsp;${an.verdict}</span>`
      : "";
    const jjinTag = an && an.jjin != null
      ? `<span style="color:#2b8a3e;font-weight:bold">찐 ${Math.round(an.jjin)}</span> · `
      : "";
    const nv = p.naver;
    const nvTag = nv && nv.score
      ? ` · <span style="color:#03c75a;font-weight:bold">N★${nv.score}</span>(${nv.review_total ?? "?"})`
      : "";
    const dcLine = (dc
      ? `${jjinTag}<span style="color:#d9480f;font-weight:bold">DC ${dc.score}</span>
         · ★${dc.user_score ?? "-"}${an && an.adj_star ? `→<b>${an.adj_star}</b>` : ""} (${dc.review_cnt ?? 0})`
      : `<span style="color:#aaa">다이닝코드 정보 없음</span>`) + nvTag;
    const chainTag = an && an.franchise
      ? `<span class="cattag" style="background:#e7f5ff;color:#1971c2">체인</span>` : "";
    div.innerHTML = `<div class="nm">${p.name}<span class="cattag">${fineCat(p)}</span>${chainTag} ${badge}</div>
      <div class="sub">${p.dist_m}m · ${dcLine}</div>`;
    div.onclick = () => {
      map.panTo(new kakao.maps.LatLng(p.lat, p.lon));
      openInfo(p);
    };
    list.appendChild(div);
  });
}

let openedInfoId = null;   // 현재 열린 정보창의 kakao_id (재클릭 토글용)
let placeGroups = {};      // kakao_id -> 같은 위치 그룹 배열
let curGroup = null, curIdx = 0;   // 정보창 페이지 넘김 상태

function infoHtml(p) {
  const dc = p.diningcode;
  const an = p.analysis;
  const anBlock = an
    ? `<div style="margin:4px 0; padding:4px 6px; border-left:3px solid ${an.color};
                background:#f8f9fa; font-size:12px;">
         <b style="color:${an.color}">${an.verdict}</b>
         ${an.adj_star ? ` · 보정별점 ★${an.adj_star}` : ""}<br>
         ${(an.reasons || []).map(r => "· " + r).join("<br>")}
       </div>`
    : "";
  // 강점/약점 키워드 칩 (약점은 여과 없이 — 부정 리뷰는 조작이 드묾)
  const rs = p.review_summary;
  const chip = (label, cnt, color, bg) =>
    `<span style="display:inline-block;margin:1px 2px;padding:1px 7px;border-radius:10px;
      font-size:11px;color:${color};background:${bg};">${label} ×${cnt}</span>`;
  const kwBlock = rs && (rs.pros.length || rs.cons.length)
    ? `<div style="margin:4px 0;">
         ${rs.pros.map(([k, c]) => chip("👍 " + k, c, "#2b8a3e", "#ebfbee")).join("")}
         ${rs.cons.map(([k, c]) => chip("👎 " + k, c, "#c92a2a", "#fff5f5")).join("")}
         <span style="font-size:10px;color:#999">(리뷰 ${rs.n_texts}건 분석)</span>
       </div>`
    : "";
  const nv = p.naver;
  const nvBlock = nv && nv.score
    ? `<div style="margin:4px 0; padding:4px 6px; background:#e6fcf0; border-radius:4px;">
         <b style="color:#03c75a">네이버 ★${nv.score}</b> · 리뷰 ${nv.review_total ?? "?"}개<br>
         <span style="color:#666; font-size:11px">
           영수증 인증 ${nv.receipt_ratio != null ? Math.round(nv.receipt_ratio * 100) + "%" : "-"} ·
           재방문자 비율 ${nv.revisit_ratio != null ? Math.round(nv.revisit_ratio * 100) + "%" : "-"}
           (최근 ${nv.sampled}건 기준)
         </span>
       </div>`
    : "";
  const dcBlock = dc
    ? `<div style="margin:4px 0; padding:4px 6px; background:#fff4e6; border-radius:4px;">
         <b style="color:#d9480f">다이닝코드 ${dc.score}점</b>
         · 사용자 ★${dc.user_score ?? "-"} · 리뷰 ${dc.review_cnt ?? 0}개<br>
         <span style="color:#888; font-size:11px">${(dc.keywords || []).slice(0, 4).join(" · ")}</span>
       </div>`
    : `<div style="margin:4px 0; color:#999">다이닝코드에 등록되지 않은 곳</div>`;
  // 판정 피드백 버튼 (내 평가를 정답 데이터로 축적) — 배포본(서버 없음)에선 숨김
  const fb = window.STATIC_MODE ? "" : `
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee;font-size:11px;"
           id="fb-${p.kakao_id}">
        내가 먹어본 평가:<br>
        <button class="fbtn" onclick="sendFeedback('${p.kakao_id}','찐맛집')">👍 찐맛집</button>
        <button class="fbtn" onclick="sendFeedback('${p.kakao_id}','맛있음')">😋 맛있음</button>
        <button class="fbtn" onclick="sendFeedback('${p.kakao_id}','괜찮음')">🙂 괜찮음</button>
        <button class="fbtn" onclick="sendFeedback('${p.kakao_id}','별로')">👎 별로</button>
      </div>`;
  return `
      <b>${p.name}</b><br>
      <span style="color:#777">${p.category}</span><br>
      ${anBlock}
      ${kwBlock}
      ${nvBlock}
      ${dcBlock}
      중심에서 ${p.dist_m}m ·
      <a href="${p.kakao_url}" target="_blank">카카오맵</a>
      ${dc ? `· <a href="https://www.diningcode.com/profile.php?rid=${dc.v_rid}" target="_blank">다이닝코드</a>` : ""}
      ${fb}`;
}

// 지역 조사 요청 → 서버가 data/region_requests.jsonl 에 축적
async function requestRegion(query) {
  const note = prompt(`"${query}" 지역 조사를 요청합니다. 남길 말이 있으면 적어주세요 (선택):`, "");
  if (note === null) return;   // 취소
  try {
    await fetch("/api/region_request", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, note }),
    });
    alert("요청이 접수됐습니다. 나중에 수집 목록에 반영됩니다.");
  } catch (e) {
    alert("요청 저장 실패 (서버 꺼짐?)");
  }
}

// 판정 피드백 전송 → 서버가 data/feedback.jsonl 에 축적 (정답 표본)
async function sendFeedback(kakaoId, userSays) {
  const p = allPlaces.find(x => x.kakao_id === kakaoId);
  const box = document.getElementById("fb-" + kakaoId);
  try {
    await fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kakao_id: kakaoId, name: p.name, region: currentRegion,
        category: p.category, verdict_now: p.analysis ? p.analysis.verdict : null,
        jjin: p.analysis ? p.analysis.jjin : null, user_says: userSays,
      }),
    });
    if (box) box.innerHTML = `<span style="color:#2b8a3e">평가 저장됨 (${userSays}) — 고마워요!</span>`;
  } catch (e) {
    if (box) box.innerHTML = `<span style="color:#c92a2a">저장 실패 (서버 꺼짐?)</span>`;
  }
}

function showGroupPage() {
  const p = curGroup[curIdx];
  // 같은 건물에 여러 곳이면 상단에 ◀ n/N ▶ 페이저 표시
  const pager = curGroup.length > 1
    ? `<div style="display:flex;align-items:center;justify-content:space-between;
                 background:#f1f3f5;border-radius:6px;padding:2px 6px;margin-bottom:5px;">
         <button onclick="window.__grpNav(-1)" style="border:none;background:none;
                 font-size:15px;cursor:pointer;padding:2px 8px;">◀</button>
         <span style="font-size:12px;color:#555">같은 위치 ${curIdx + 1} / ${curGroup.length}곳</span>
         <button onclick="window.__grpNav(1)" style="border:none;background:none;
                 font-size:15px;cursor:pointer;padding:2px 8px;">▶</button>
       </div>`
    : "";
  infoWindow.setContent(
    `<div style="padding:8px 12px; font-size:13px; min-width:220px; max-width:280px;">
       ${pager}${infoHtml(p)}
     </div>`);
  infoWindow.open(map, markers[p.kakao_id]);
  openedInfoId = p.kakao_id;
}

window.__grpNav = (d) => {
  curIdx = (curIdx + d + curGroup.length) % curGroup.length;
  showGroupPage();
};

function openGroup(grp, idx) {
  const p = grp[idx];
  if (openedInfoId === p.kakao_id) {   // 같은 항목 재클릭 → 닫기
    infoWindow.close();
    openedInfoId = null;
    return;
  }
  curGroup = grp;
  curIdx = idx;
  showGroupPage();
}

function openInfo(p) {
  const grp = placeGroups[p.kakao_id] || [p];
  openGroup(grp, Math.max(grp.indexOf(p), 0));
}

// ---------- 새 지역 검색·수집 (서버 API 사용) ----------
let selectedCandidate = null;
let previewCircle = null;    // 수집 범위 미리보기 원
let previewMarker = null;    // 원 중심의 드래그 핀 (임의 위치로 이동)

// 선택한 후보 + 현재 반경으로 미리보기 원을 그린다.
// fitBounds=true 면 원 전체가 보이게 지도를 맞춤(후보 선택·반경 변경 시).
// 드래그 중에는 지도를 리센터하지 않기 위해 fitBounds=false.
function updatePreviewCircle(fitBounds = true) {
  if (!selectedCandidate) return;
  const { lat, lon } = selectedCandidate;
  const radius = currentRadius();
  const center = new kakao.maps.LatLng(lat, lon);

  if (previewCircle) previewCircle.setMap(null);
  previewCircle = new kakao.maps.Circle({
    map, center, radius,
    strokeWeight: 3, strokeColor: "#f76707", strokeOpacity: 0.9,
    strokeStyle: "dash",                       // 점선: 아직 수집 전임을 표시
    fillColor: "#f76707", fillOpacity: 0.08,
  });

  // 드래그 가능한 중심 핀 — 끌어서 원 위치를 임의로 옮김
  // 카카오 마커는 연속 drag 이벤트가 없어, 드래그 중 위치를 폴링해 원을 실시간 추종시킨다.
  if (!previewMarker) {
    previewMarker = new kakao.maps.Marker({ position: center, draggable: true });
    previewMarker.setMap(map);
    let dragTimer = null;
    kakao.maps.event.addListener(previewMarker, "dragstart", () => {
      dragTimer = setInterval(() => {
        if (previewCircle) previewCircle.setPosition(previewMarker.getPosition());
      }, 16);   // ~60fps 로 원이 핀을 따라감
    });
    kakao.maps.event.addListener(previewMarker, "dragend", () => {
      clearInterval(dragTimer);
      const pos = previewMarker.getPosition();
      selectedCandidate.lat = pos.getLat();   // 수집 좌표 확정
      selectedCandidate.lon = pos.getLng();
      if (previewCircle) previewCircle.setPosition(pos);
    });
  } else {
    previewMarker.setPosition(center);
    previewMarker.setMap(map);
  }

  if (fitBounds) {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    map.setBounds(new kakao.maps.LatLngBounds(
      new kakao.maps.LatLng(lat - dLat, lon - dLon),
      new kakao.maps.LatLng(lat + dLat, lon + dLon)));
  }
}

function clearPreviewCircle() {
  if (previewCircle) { previewCircle.setMap(null); previewCircle = null; }
  if (previewMarker) { previewMarker.setMap(null); previewMarker = null; }
}

async function searchRegion() {
  const q = document.getElementById("q").value.trim();
  if (!q) return;
  const box = document.getElementById("qResults");
  box.innerHTML = `<div class="sub" style="padding:4px">검색 중...</div>`;
  try {
    const res = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    box.innerHTML = "";
    if (!res.candidates || res.candidates.length === 0) {
      box.innerHTML = `<div class="sub" style="padding:4px">결과 없음 —
        <a href="#" onclick="requestRegion('${q}');return false;">이 지역 조사 요청하기</a></div>`;
      return;
    }
    // 항상 하단에 "이 지역 조사 요청" 안내 (미수집 지역 건의용)
    const reqNote = document.createElement("div");
    reqNote.className = "sub";
    reqNote.style.padding = "3px";
    reqNote.innerHTML = `찾는 곳이 없나요? <a href="#" onclick="requestRegion('${q}');return false;">이 지역 조사 요청</a>`;
    box.appendChild(reqNote);
    res.candidates.forEach(c => {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `<div class="nm" style="font-size:13px">${c.name}</div>
        <div class="sub">${c.address}</div>`;
      div.onclick = () => {
        selectedCandidate = { ...c, label: q };
        box.innerHTML = "";
        document.getElementById("collectTarget").innerHTML =
          `${c.name} 주변을 수집합니다<br>` +
          `<span style="font-weight:normal;color:#f76707;font-size:11px">📍 핀을 끌어 위치를 옮길 수 있어요</span>`;
        document.getElementById("collectPanel").style.display = "block";
        updatePreviewCircle();   // 수집 범위 미리보기 원 표시 + 지도 맞춤
      };
      box.appendChild(div);
    });
  } catch (e) {
    box.innerHTML = `<div class="sub" style="padding:4px">검색 실패: ${e}</div>`;
  }
}

// 반경 프리셋: "직접 입력" 선택 시에만 숫자 입력칸 표시
document.getElementById("radiusPreset").onchange = function () {
  const custom = this.value === "custom";
  document.getElementById("radiusInput").style.display = custom ? "inline-block" : "none";
  document.getElementById("radiusUnit").style.display = custom ? "inline" : "none";
  updatePreviewCircle();   // 반경 바뀌면 미리보기 원 갱신
};
document.getElementById("radiusInput").addEventListener("input", updatePreviewCircle);

function currentRadius() {
  const preset = document.getElementById("radiusPreset").value;
  if (preset !== "custom") return parseInt(preset);
  return parseInt(document.getElementById("radiusInput").value) || 300;
}

async function startCollect() {
  if (!selectedCandidate) return;
  const radius = currentRadius();
  const res = await (await fetch("/api/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ region: selectedCandidate.label, radius,
                           lon: selectedCandidate.lon, lat: selectedCandidate.lat }),
  })).json();
  if (res.error) { alert(res.error); return; }
  document.getElementById("collectPanel").style.display = "none";
  clearPreviewCircle();   // 수집 시작: 점선 미리보기 제거 (완료 후 파란 실선 원이 표시됨)
  pollCollect(res.region);
}

// 단계별 진행 구간 [표시명, 시작점, 비중] — 네이버가 가장 오래 걸려 비중 최대
const PHASE_RANGE = {
  kakao:      ["식당 목록 수집",   0.00, 0.03],
  diningcode: ["다이닝코드 수집",  0.03, 0.25],
  matcher:    ["소스 매칭",       0.28, 0.02],
  naver:      ["네이버 리뷰 수집", 0.30, 0.62],
  post:       ["판별·정리",       0.92, 0.08],
};

// 로그를 훑어 마지막 단계와 그 안의 진행률(frac)을 구한다.
// diningcode/naver 는 수집기가 내보내는 "[PCT] <phase> <done> <total>" 로 정밀 추정.
function collectProgress(log) {
  let key = "kakao", frac = 0;
  for (const l of (log || "").split("\n")) {
    if (l.includes("===== kakao")) { key = "kakao"; frac = 0; }
    else if (l.includes("===== diningcode")) { key = "diningcode"; frac = 0; }
    else if (l.includes("===== matcher")) { key = "matcher"; frac = 0; }
    else if (l.includes("===== naver_place")) { key = "naver"; frac = 0; }
    else if (l.includes("===== naver_merge") || l.includes("===== keywords")
             || l.includes("===== score")) { key = "post"; frac = 0; }
    const m = l.match(/\[PCT\] (\w+) (\d+) (\d+)/);
    if (m && (m[1] === "diningcode" || m[1] === "naver")) {
      key = m[1];
      frac = +m[3] > 0 ? Math.min(+m[2] / +m[3], 1) : 0;
    }
  }
  const [label, off, w] = PHASE_RANGE[key];
  return { label, pct: off + frac * w };
}

function fmtSec(s) {
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

async function pollCollect(region) {
  const prog = document.getElementById("progress");
  prog.style.display = "block";
  prog.innerHTML = `<div id="progressHead"><span class="spinner"></span>데이터 수집 중...</div>`;
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      const st = await (await fetch("/api/collect/status")).json();
      const lines = (st.log || "").trim().split("\n");
      const { label, pct } = collectProgress(st.log || "");
      const elapsed = (Date.now() - t0) / 1000;
      // 예상 남은 시간: 경과시간을 진행률로 외삽 (진행률 5% 미만이면 표시 보류)
      const eta = pct >= 0.02 ? fmtSec(elapsed * (1 - pct) / pct) : "계산 중";
      prog.innerHTML =
        `<div id="progressHead"><span class="spinner"></span>` +
        `[${region}] 데이터 수집 중 — ${label} ${(pct * 100).toFixed(0)}%<br>` +
        `<span style="font-weight:normal">경과 ${fmtSec(elapsed)} · 예상 남은 시간 ${eta}</span></div>` +
        lines.slice(-4).join("\n");
      // 자동 스크롤 없음 — 상단의 경과/예상 시간이 항상 보이게 유지
      if (!st.running) {
        clearInterval(timer);
        if (st.exit_code === 0) {
          prog.textContent = `[${region}] 수집 완료!`;
          setTimeout(() => { prog.style.display = "none"; }, 3000);
          await refreshRegions(region);   // 목록 갱신 + 새 지역으로 전환
        } else {
          prog.textContent += `\n[실패] exit=${st.exit_code} — 로그를 확인하세요`;
        }
      }
    } catch (e) { /* 서버 일시 오류는 다음 폴링에서 회복 */ }
  }, 3000);
}

async function refreshRegions(selectRegion) {
  const regions = await (await fetch(REGIONS_URL + "?t=" + Date.now())).json();
  const sel = document.getElementById("regionSel");
  sel.innerHTML = "";
  regions.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r.region;
    opt.textContent = `${r.region} (반경 ${r.radius_m}m)`;
    sel.appendChild(opt);
  });
  if (selectRegion) { sel.value = selectRegion; loadRegion(selectRegion); }
}

// 모바일 하단 시트: 손잡이를 잡고 위아래로 드래그해 지도/목록 비율 자유 조절
(function setupSheetDrag() {
  const handle = document.getElementById("sheetToggle");
  const sb = document.getElementById("sidebar");
  const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
  let dragging = false, startY = 0, startH = 0, moved = false, relayoutTimer = null;

  const pointY = e => (e.touches ? e.touches[0].clientY : e.clientY);
  const clampH = h => Math.max(window.innerHeight * 0.12,
                               Math.min(window.innerHeight * 0.88, h));

  function onDown(e) {
    if (!isMobile()) return;
    dragging = true; moved = false;
    startY = pointY(e); startH = sb.offsetHeight;
    sb.classList.add("dragging");
    sb.classList.remove("collapsed", "expanded");
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const dy = startY - pointY(e);          // 위로 끌면 커짐
    if (Math.abs(dy) > 4) moved = true;
    sb.style.height = clampH(startH + dy) + "px";
    // 드래그 중에도 지도가 자연스럽게 따라오도록 가볍게 relayout (throttle)
    if (!relayoutTimer) relayoutTimer = setTimeout(() => {
      map && map.relayout(); relayoutTimer = null;
    }, 60);
    e.preventDefault();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    sb.classList.remove("dragging");
    // 움직임 없이 탭만 했으면: 접힘 ↔ 기본 간단 토글
    if (!moved) sb.style.height = sb.offsetHeight < window.innerHeight * 0.25
      ? window.innerHeight * 0.42 + "px" : window.innerHeight * 0.15 + "px";
    map && map.relayout();
  }

  handle.addEventListener("touchstart", onDown, { passive: false });
  handle.addEventListener("touchmove", onMove, { passive: false });
  handle.addEventListener("touchend", onUp);
  handle.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // 데스크톱으로 넓어지면 인라인 높이 제거 (가로 레이아웃 복귀)
  window.addEventListener("resize", () => { if (!isMobile()) sb.style.height = ""; });
})();

if (window.STATIC_MODE) {
  // 정적 배포(조회 전용): 수집 관련 UI 숨김, 지역 요청 링크 표시
  ["searchRow", "collectPanel", "progress"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  if (window.REQUEST_FORM_URL) {
    const row = document.getElementById("requestRow");
    row.style.display = "block";
    row.innerHTML = `🙋 <a href="${window.REQUEST_FORM_URL}" target="_blank">우리 동네도 조사해 달라고 요청하기</a>`;
  }
} else {
  document.getElementById("qBtn").onclick = searchRegion;
  document.getElementById("q").addEventListener("keydown",
    e => { if (e.key === "Enter") searchRegion(); });
  document.getElementById("collectBtn").onclick = startCollect;
}

kakao.maps.load(init);

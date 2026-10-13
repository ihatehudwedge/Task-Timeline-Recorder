/**
 * ============================================================================
 * [사용자 커스텀 영역] 자주 쓰는 타임라인 템플릿 문구 목록
 * ============================================================================
 */
const TIMELINE_TEMPLATES = [
  { label: "🚀 작업착수", text: "[작업착수] 작업 시작 및 사전 상태 점검 완료" },
  { label: "✅ 서비스 체크", text: "[서비스 체크] 서비스 정상 동작 확인 (특이사항 없음)" },
  { label: "📢 유관공유", text: "[유관부서 공유] 메신저 상황 공유 완료: " },
  { label: "⚠️ 이슈발생", text: "[이슈발생] 증상 및 원인 탐구 중: " },
  { label: "🔎 원인분석", text: "[원인분석] 장애 발생 원인 확인: " },
  { label: "🔄 롤백/보류", text: "[조치사항] 설정 원복 및 경과 모니터링 진행" },
  { label: "🏁 작업종료", text: "[작업종료] 최종 확인 완료 및 작업 종료" }
];

const STATUS_OPTIONS = ["대기", "진행", "이슈발생", "종료"];

let appData = { cards: [] };
let directoryHandle = null; 
let currentFilterStatus = "ALL";
let editingCardId = null;
let draftStatus = "대기";
let draftTimeline = [];
let removedTimelineIdsInSession = new Set();

// 페이지네이션 및 검색 지연 변수
let currentPage = 1;
const CARDS_PER_PAGE = 30; // 한 번에 화면에 그릴 카드 수 (과부하 방지)
let searchTimer = null;

// ============================================================================
// [DB] IndexedDB 설정 (권한, 1만개 파일 동기화 캐시, 임시 파일 백업)
// ============================================================================
const DB_NAME = "TimelineAppDB";
const STORE_HANDLES = "folder_handles";
const STORE_CARDS_CACHE = "cards_meta_cache"; // 파일 증분 동기화용 캐시
const STORE_FALLBACK = "fallback_cache";      // 공유 폴더 미연결 시 로컬 저장소 (5MB 제한 없음)

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_FALLBACK)) db.createObjectStore(STORE_FALLBACK);
      if (!db.objectStoreNames.contains(STORE_CARDS_CACHE)) {
        db.createObjectStore(STORE_CARDS_CACHE, { keyPath: "fileName" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  renderTemplateChips();
  await loadFallbackData(); // 공유 폴더 미연결 상태일 때 볼 임시 데이터 로드
  renderBoard(true);
  await checkSavedFolderOnLoad(); // 권한 복구 및 폴더 스캔
});

// ============================================================================
// 1. 핵심: 증분 동기화 스캔 (Delta Sync) - 1만개 1초 스캔 로직
// ============================================================================
async function loadAllCardsFromDirectory() {
  if (!directoryHandle) return;
  const db = await initDB();

  // 기존에 읽어뒀던 1만개 파일의 날짜 및 데이터를 캐시(Map)로 불러옴
  const cachedMap = new Map();
  await new Promise(resolve => {
    const tx = db.transaction(STORE_CARDS_CACHE, "readonly");
    const req = tx.objectStore(STORE_CARDS_CACHE).getAll();
    req.onsuccess = () => {
      req.result.forEach(item => cachedMap.set(item.fileName, item));
      resolve();
    };
  });

  const currentFileNames = new Set();
  let updatedCount = 0;

  // 디스크 파일들의 날짜(lastModified)만 광속 스캔
  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "file" && (entry.name.endsWith(".json") || entry.name.endsWith(".card"))) {
      currentFileNames.add(entry.name);
      const file = await entry.getFile();
      const lastModified = file.lastModified;

      const cached = cachedMap.get(entry.name);
      
      // 날짜가 바뀌었거나(최신), 캐시에 없는 새 파일일 때만 내용을 읽어옴
      if (!cached || cached.lastModified !== lastModified) {
        try {
          const text = await file.text();
          if (!text.trim()) continue;
          const parsed = JSON.parse(text);

          const cardsInFile = [];
          if (parsed && parsed.id && parsed.title !== undefined) {
            if (!Array.isArray(parsed.timeline)) parsed.timeline = [];
            cardsInFile.push(parsed);
          } else if (parsed && Array.isArray(parsed.cards)) {
            parsed.cards.forEach(c => { if (c && c.id) cardsInFile.push(c); });
          }

          cachedMap.set(entry.name, {
            fileName: entry.name,
            lastModified: lastModified,
            data: cardsInFile
          });
          updatedCount++;
        } catch (e) {
          console.warn(`파일 읽기 실패 (${entry.name}):`, e);
        }
      }
    }
  }

  // 폴더에서 삭제된 파일 캐시 정리
  for (const fileName of cachedMap.keys()) {
    if (!currentFileNames.has(fileName)) cachedMap.delete(fileName);
  }

  // 캐시 DB 저장 (Bulk)
  const tx = db.transaction(STORE_CARDS_CACHE, "readwrite");
  const store = tx.objectStore(STORE_CARDS_CACHE);
  store.clear();
  cachedMap.forEach(item => store.put(item));
  
  // 메모리 반영 및 최신순 정렬
  const loadedCards = [];
  cachedMap.forEach(item => loadedCards.push(...item.data));
  loadedCards.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  appData.cards = loadedCards;

  if (updatedCount > 0) console.log(`${updatedCount}개 파일 업데이트(스캔) 완료`);
  
  await saveFallbackData(); // 안전 장치
  renderBoard(true);
}

// ============================================================================
// 2. 가상 렌더링(페이지네이션) 및 검색 디바운싱
// ============================================================================
function handleSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    renderBoard(true); // 입력 멈추고 0.3초 후 1번만 렌더링
  }, 300);
}

function renderBoard(resetPage = false) {
  updateWorkerDropdown();

  if (resetPage) currentPage = 1;

  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const selectedWorker = document.getElementById("workerFilterSelect").value;

  const counts = { ALL: appData.cards.length, "대기": 0, "진행": 0, "이슈발생": 0, "종료": 0 };
  appData.cards.forEach(c => { if (counts[c.status] !== undefined) counts[c.status]++; });

  document.getElementById("summaryCounts").innerHTML = `
    <span>전체 카드 <b>${counts.ALL}</b></span>
    <span>대기 <b>${counts["대기"]}</b></span>
    <span style="color:var(--status-prog-text)">진행 <b>${counts["진행"]}</b></span>
    <span style="color:var(--status-issue-text)">이슈발생 <b>${counts["이슈발생"]}</b></span>
    <span style="color:var(--status-done-text)">종료 <b>${counts["종료"]}</b></span>
  `;

  // 1만개 메모리 통합 검색 (매우 빠름)
  const filtered = appData.cards.filter(card => {
    if (currentFilterStatus !== "ALL" && card.status !== currentFilterStatus) return false;
    if (selectedWorker !== "ALL" && (card.worker || "").trim() !== selectedWorker) return false;
    if (query) {
      const hayTitle = (card.title || "").toLowerCase();
      const hayWorker = (card.worker || "").toLowerCase();
      const hayAuthor = (card.author || "").toLowerCase();
      const hayId = (card.id || "").toLowerCase();
      const hayTl = (card.timeline || []).map(t => `${t.author} ${t.content} ${t.time}`).join(" ").toLowerCase();
      if (!hayTitle.includes(query) && !hayWorker.includes(query) && !hayAuthor.includes(query) && !hayId.includes(query) && !hayTl.includes(query)) {
        return false;
      }
    }
    return true;
  });

  const grid = document.getElementById("cardsGrid");
  if (resetPage) grid.innerHTML = ""; // 페이지 초기화 시에만 DOM 삭제

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-board" style="grid-column: 1 / -1; break-inside: avoid;">
        <p style="font-size:15px; font-weight:700; margin-bottom:6px;">등록된 작업 카드가 없습니다.</p>
      </div>
    `;
    return;
  }

  // 과부하 방지: 30개씩 분할 렌더링
  const startIndex = (currentPage - 1) * CARDS_PER_PAGE;
  const endIndex = startIndex + CARDS_PER_PAGE;
  const pageCards = filtered.slice(startIndex, endIndex);

  pageCards.forEach(card => {
    const curStatus = card.status || "대기";
    const cardEl = document.createElement("div");
    cardEl.className = "task-card" + (card.id === editingCardId ? " active-editing" : "");
    cardEl.setAttribute("data-status", curStatus);

    const sortedTl = [...(card.timeline || [])].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    let tlHtml = sortedTl.length === 0 ? `<div class="card-empty-tl">메모 없음</div>` : sortedTl.map(tl => `
      <div class="tl-entry"><div class="tl-meta"><span class="tl-time">${escapeHtml(tl.time)}</span><span class="tl-writer">${escapeHtml(tl.author || "미상")}</span></div><div class="tl-text">${escapeHtml(tl.content)}</div></div>
    `).join("");

    const statusOptionsHtml = STATUS_OPTIONS.map(st => `<option value="${st}" ${st === curStatus ? "selected" : ""}>${st}</option>`).join("");

    cardEl.innerHTML = `
      <div class="card-top"><div><span class="card-id-badge">${escapeHtml(card.id)}</span></div><div style="display:flex; align-items:center; gap:6px;"><select class="card-status-select" data-status="${escapeHtml(curStatus)}" onchange="changeCardStatusDirect('${escapeHtml(card.id)}', this.value)">${statusOptionsHtml}</select><button class="btn btn-sm" onclick="openDrawerForEditCard('${escapeHtml(card.id)}')">✎ 수정</button></div></div>
      <div class="card-title">${escapeHtml(card.title)}</div>
      <div class="card-meta"><div class="meta-people"><span class="meta-item"><span class="meta-label">작업:</span><span class="meta-val">${escapeHtml(card.worker || "-")}</span></span><span class="meta-item"><span class="meta-label">작성:</span><span class="meta-val">${escapeHtml(card.author || "-")}</span></span></div><span>로그 ${sortedTl.length}건</span></div>
      <div class="card-timeline">${tlHtml}</div>
      <div class="card-footer"><span>수정: ${escapeHtml(card.updatedAt || "-")}</span><span>${escapeHtml(getCardFileName(card.id))}</span></div>
    `;
    grid.appendChild(cardEl);
  });

  // '더보기' 버튼 처리
  let loadMoreBtn = document.getElementById("loadMoreBtn");
  if (loadMoreBtn) loadMoreBtn.remove();
  if (endIndex < filtered.length) {
    loadMoreBtn = document.createElement("button");
    loadMoreBtn.id = "loadMoreBtn";
    loadMoreBtn.className = "btn";
    loadMoreBtn.textContent = `더보기 (${filtered.length - endIndex}개 남음) ▼`;
    loadMoreBtn.style.cssText = "width: 100%; grid-column: 1 / -1; break-inside: avoid; padding: 12px; margin-top: 10px;";
    loadMoreBtn.onclick = () => { currentPage++; renderBoard(false); };
    grid.appendChild(loadMoreBtn);
  }
}

function setStatusFilter(status) {
  currentFilterStatus = status;
  document.querySelectorAll("#statusFilterGroup .filter-pill").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === status);
  });
  renderBoard(true);
}

function updateWorkerDropdown() {
  const select = document.getElementById("workerFilterSelect");
  const prevValue = select.value;
  const workers = new Set();
  appData.cards.forEach(c => { if (c.worker && c.worker.trim()) workers.add(c.worker.trim()); });
  select.innerHTML = `<option value="ALL">모든 작업자 (${workers.size}명)</option>`;
  Array.from(workers).sort().forEach(w => { select.innerHTML += `<option value="${w}">작업자: ${w}</option>`; });
  select.value = [...workers].includes(prevValue) ? prevValue : "ALL";
}

// ============================================================================
// 3. 파일 저장 (Atomic Write) 및 삭제 (.erase 백업), 채번 로직
// ============================================================================
function getCardFileName(cardId) {
  return `${String(cardId).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

async function saveSingleCardFileToDirectory(cardObj, customToastMsg = null) {
  if (!directoryHandle) {
    updateMemoryCacheAndRender(cardObj);
    showToast(customToastMsg || "임시 저장되었습니다 (공유 폴더 미연결).", "success");
    return;
  }
  try {
    const fileName = getCardFileName(cardObj.id);
    let finalCard = { ...cardObj };

    try {
      const existingFileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
      const existingFile = await existingFileHandle.getFile();
      const diskCard = JSON.parse(await existingFile.text());
      if (diskCard && Array.isArray(diskCard.timeline)) {
        const mergedMap = new Map();
        (cardObj.timeline || []).forEach(tl => mergedMap.set(tl.id, tl));
        diskCard.timeline.forEach(diskTl => {
          if (!mergedMap.has(diskTl.id) && !removedTimelineIdsInSession.has(diskTl.id)) mergedMap.set(diskTl.id, diskTl);
        });
        finalCard.timeline = Array.from(mergedMap.values()).sort((a, b) => (b.time || "").localeCompare(a.time || ""));
      }
    } catch (e) { /* 새 파일 */ }

    // Atomic Write
    const fileData = JSON.stringify(finalCard, null, 2);
    const tmpFileName = fileName + ".tmp";
    const tmpHandle = await directoryHandle.getFileHandle(tmpFileName, { create: true });
    const tmpWritable = await tmpHandle.createWritable();
    await tmpWritable.write(fileData);
    await tmpWritable.close();

    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(fileData);
    await writable.close();

    try { await directoryHandle.removeEntry(tmpFileName); } catch (e) {}

    updateMemoryCacheAndRender(finalCard);
    showToast(customToastMsg || `카드 파일이 폴더에 안전하게 저장되었습니다.`, "success");
  } catch (err) {
    showToast("저장 오류: " + err.message, "warn");
  }
}

async function deleteSingleCardFileFromDirectory(cardId) {
  if (!directoryHandle) {
    appData.cards = appData.cards.filter(c => c.id !== cardId);
    await saveFallbackData();
    renderBoard(true);
    showToast(`카드(${cardId})가 삭제되었습니다.`, "success");
    return;
  }
  try {
    const fileName = getCardFileName(cardId);
    const eraseFileName = fileName + ".erase";
    try {
      const existingFileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
      const fileData = await (await existingFileHandle.getFile()).text();
      const eraseHandle = await directoryHandle.getFileHandle(eraseFileName, { create: true });
      const writable = await eraseHandle.createWritable();
      await writable.write(fileData);
      await writable.close();
      await directoryHandle.removeEntry(fileName);
      showToast(`삭제 처리(.erase 백업) 완료`, "success");
    } catch (e) {
      showToast(`원본을 찾을 수 없어 목록에서 제거함`, "success");
    }
    appData.cards = appData.cards.filter(c => c.id !== cardId);
    await saveFallbackData();
    renderBoard(true);
  } catch (err) {
    showToast(`삭제 중 오류: ` + err.message, "warn");
  }
}

async function getNextTaskNumber() {
  let max = 100;
  appData.cards.forEach(c => {
    const match = String(c.id).match(/TASK-(\d+)/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  });
  if (directoryHandle) {
    try {
      for await (const entry of directoryHandle.values()) {
        if (entry.kind === "file") {
          const match = entry.name.match(/TASK-(\d+)/);
          if (match) max = Math.max(max, parseInt(match[1], 10));
        }
      }
    } catch (e) {}
  }
  return max + 1;
}

function updateMemoryCacheAndRender(finalCard) {
  const idx = appData.cards.findIndex(c => c.id === finalCard.id);
  if (idx !== -1) appData.cards[idx] = finalCard;
  else appData.cards.unshift(finalCard);
  saveFallbackData();
  renderBoard(true);
}

// ============================================================================
// 4. 폴백 데이터 (IndexedDB 5MB 이상 캐시) 및 폴더 연결 관리
// ============================================================================
async function saveFallbackData() {
  const db = await initDB();
  const tx = db.transaction(STORE_FALLBACK, "readwrite");
  tx.objectStore(STORE_FALLBACK).put(appData, "fallback_data");
}

async function loadFallbackData() {
  const db = await initDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_FALLBACK, "readonly");
    const req = tx.objectStore(STORE_FALLBACK).get("fallback_data");
    req.onsuccess = () => {
      if (req.result && Array.isArray(req.result.cards)) appData.cards = req.result.cards;
      resolve();
    };
    req.onerror = () => resolve();
  });
}

async function saveFolderHandle(handle) {
  const db = await initDB();
  const tx = db.transaction(STORE_HANDLES, "readwrite");
  tx.objectStore(STORE_HANDLES).put(handle, "lastFolderHandle");
}

async function getFolderHandle() {
  const db = await initDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_HANDLES, "readonly");
    const req = tx.objectStore(STORE_HANDLES).get("lastFolderHandle");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function checkSavedFolderOnLoad() {
  try {
    const handle = await getFolderHandle();
    if (handle) {
      document.getElementById("lastFolderName").textContent = `'${handle.name}'`;
      document.getElementById("permissionModal").style.display = "flex";
    }
  } catch (e) { }
}

async function restoreFolderConnection() {
  closePermissionModal();
  try {
    const handle = await getFolderHandle();
    if (!handle) return;
    const options = { mode: 'readwrite' };
    let isGranted = (await handle.queryPermission(options)) === 'granted';
    if (!isGranted) isGranted = (await handle.requestPermission(options)) === 'granted';
    
    if (isGranted) {
      directoryHandle = handle;
      await loadAllCardsFromDirectory();
      updateFolderStatusUI(handle.name);
      showToast(`'${handle.name}' 폴더 연결 완료`, "success");
    }
  } catch (e) { showToast("권한 복구 실패", "warn"); }
}

function closePermissionModal() { document.getElementById("permissionModal").style.display = "none"; }

async function connectCardDirectory() {
  if (!window.showDirectoryPicker) return showToast("브라우저 미지원. 파일 불러오기를 이용하세요.", "warn");
  try {
    directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveFolderHandle(directoryHandle);
    await loadAllCardsFromDirectory();
    updateFolderStatusUI(directoryHandle.name);
    showToast(`'${directoryHandle.name}' 카드 폴더 연결 완료`, "success");
  } catch (err) { }
}

async function reloadCardsFromDirectory() {
  if (!directoryHandle) return showToast("공유 폴더를 먼저 연결해주세요.", "warn");
  await loadAllCardsFromDirectory();
  if (editingCardId) openDrawerForEditCard(editingCardId, false);
}

function updateFolderStatusUI(folderName) {
  const badge = document.getElementById("folderStatusBadge");
  const text = document.getElementById("folderStatusText");
  badge.classList.add("connected");
  text.textContent = `연결된 카드 폴더: ${folderName}`;
}

function triggerImportCardFiles() { document.getElementById("cardFilesInput").click(); }

async function handleImportCardFiles(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed && parsed.id) {
        if (!Array.isArray(parsed.timeline)) parsed.timeline = [];
        updateMemoryCacheAndRender(parsed);
      } else if (parsed.cards) {
        parsed.cards.forEach(c => { if (c && c.id) updateMemoryCacheAndRender(c); });
      }
    } catch (e) {}
  }
  showToast(`${files.length}개 파일 로드 완료`, "success");
  event.target.value = "";
}

// ============================================================================
// 5. Drawer UI 제어 및 타임라인 로직
// ============================================================================
function renderTemplateChips() {
  const container = document.getElementById("memoTemplateContainer");
  container.innerHTML = "";
  TIMELINE_TEMPLATES.forEach(tpl => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "chip"; btn.textContent = tpl.label;
    btn.onclick = () => insertTemplateText(tpl.text);
    container.appendChild(btn);
  });
}

function insertTemplateText(text) {
  const textarea = document.getElementById("tlMemoInput");
  const cur = textarea.value.trim();
  textarea.value = cur ? (cur + "\n" + text) : text;
  textarea.focus();
}

function formatDateTime(dateObj) {
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")} ${String(dateObj.getHours()).padStart(2, "0")}:${String(dateObj.getMinutes()).padStart(2, "0")}`;
}

function setQuickTime(offsetMinutes) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + offsetMinutes);
  document.getElementById("tlTimeInput").value = formatDateTime(now);
}

async function changeCardStatusDirect(cardId, newStatus) {
  const card = appData.cards.find(c => c.id === cardId);
  if (!card) return;
  card.status = newStatus;
  card.updatedAt = formatDateTime(new Date());
  if (editingCardId === cardId) selectEditStatus(newStatus);
  await saveSingleCardFileToDirectory(card, `${cardId} 상태가 [${newStatus}](으)로 변경됨`);
}

function openDrawerForNewCard() {
  editingCardId = null; removedTimelineIdsInSession.clear(); draftStatus = "대기"; draftTimeline = [];
  document.getElementById("drawerModeTitle").textContent = "새 카드 등록";
  document.getElementById("drawerCardId").textContent = "NEW";
  document.getElementById("editTitle").value = "";
  document.getElementById("editWorker").value = "";
  document.getElementById("editAuthor").value = "";
  document.getElementById("deleteCardBtn").style.display = "none";
  selectEditStatus("대기"); setQuickTime(0);
  document.getElementById("tlAuthorInput").value = "";
  document.getElementById("tlMemoInput").value = "";
  renderDrawerTimelineList();
  document.getElementById("leftDrawer").classList.add("open");
  setTimeout(() => document.getElementById("editTitle").focus(), 150);
}

function openDrawerForEditCard(cardId, focusMemo = false) {
  const card = appData.cards.find(c => c.id === cardId);
  if (!card) return;
  editingCardId = card.id; removedTimelineIdsInSession.clear();
  draftStatus = card.status || "대기"; draftTimeline = JSON.parse(JSON.stringify(card.timeline || []));
  document.getElementById("drawerModeTitle").textContent = "카드 수정";
  document.getElementById("drawerCardId").textContent = card.id;
  document.getElementById("editTitle").value = card.title || "";
  document.getElementById("editWorker").value = card.worker || "";
  document.getElementById("editAuthor").value = card.author || "";
  document.getElementById("deleteCardBtn").style.display = "inline-flex";
  selectEditStatus(draftStatus); setQuickTime(0);
  document.getElementById("tlAuthorInput").value = card.worker || card.author || "";
  document.getElementById("tlMemoInput").value = "";
  renderDrawerTimelineList();
  document.getElementById("leftDrawer").classList.add("open");
  if (focusMemo) setTimeout(() => document.getElementById("tlMemoInput").focus(), 150);
}

function closeDrawer() {
  editingCardId = null;
  document.getElementById("leftDrawer").classList.remove("open");
}

function selectEditStatus(status) {
  draftStatus = status;
  document.querySelectorAll("#editStatusSelector .status-opt-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.getAttribute("data-status") === status);
  });
}

function handleMemoKeydown(e) {
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); addTimelineEntryInDrawer(); }
}

function addTimelineEntryInDrawer() {
  const memoVal = document.getElementById("tlMemoInput").value.trim();
  if (!memoVal) { showToast("메모를 입력하세요.", "warn"); document.getElementById("tlMemoInput").focus(); return; }
  draftTimeline.unshift({
    id: "TL-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    time: document.getElementById("tlTimeInput").value.trim() || formatDateTime(new Date()),
    author: document.getElementById("tlAuthorInput").value.trim() || document.getElementById("editWorker").value.trim() || "담당자",
    content: memoVal
  });
  document.getElementById("tlMemoInput").value = ""; setQuickTime(0);
  renderDrawerTimelineList();
}

function renderDrawerTimelineList() {
  const listEl = document.getElementById("drawerTimelineList");
  draftTimeline.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  document.getElementById("drawerTlCount").textContent = draftTimeline.length;
  listEl.innerHTML = draftTimeline.length === 0 ? `<div class="card-empty-tl" style="text-align:center;">기록 없음</div>` : draftTimeline.map(tl => `
    <div class="drawer-tl-item"><div class="drawer-tl-header"><div><span class="drawer-tl-time">${escapeHtml(tl.time)}</span> · <span>${escapeHtml(tl.author)}</span></div><div><button class="icon-btn" onclick="editTimelineItem('${escapeHtml(tl.id)}')">수정</button><button class="icon-btn del" onclick="removeTimelineItem('${escapeHtml(tl.id)}')">삭제</button></div></div><div class="drawer-tl-content">${escapeHtml(tl.content)}</div></div>
  `).join("");
}

function editTimelineItem(tlId) {
  const item = draftTimeline.find(t => t.id === tlId);
  if (!item) return;
  document.getElementById("tlTimeInput").value = item.time;
  document.getElementById("tlAuthorInput").value = item.author;
  document.getElementById("tlMemoInput").value = item.content;
  removeTimelineItem(tlId);
  document.getElementById("tlMemoInput").focus();
}

function removeTimelineItem(tlId) {
  draftTimeline = draftTimeline.filter(t => t.id !== tlId);
  removedTimelineIdsInSession.add(tlId);
  renderDrawerTimelineList();
}

async function saveCardAndSync() {
  const title = document.getElementById("editTitle").value.trim();
  if (!title) { showToast("작업명을 입력해주세요.", "warn"); document.getElementById("editTitle").focus(); return; }
  if (document.getElementById("tlMemoInput").value.trim()) addTimelineEntryInDrawer();

  let targetCard = {
    id: editingCardId || `TASK-${await getNextTaskNumber()}`,
    title, status: draftStatus,
    worker: document.getElementById("editWorker").value.trim(),
    author: document.getElementById("editAuthor").value.trim(),
    updatedAt: formatDateTime(new Date()),
    timeline: [...draftTimeline]
  };

  await saveSingleCardFileToDirectory(targetCard);
  closeDrawer();
}

async function deleteCurrentCard() {
  if (editingCardId && confirm(`이 카드(${editingCardId})를 삭제할까요?`)) {
    await deleteSingleCardFileFromDirectory(editingCardId);
    closeDrawer();
  }
}

// ============================================================================
// 유틸리티
// ============================================================================
function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function showToast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`; toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 250); }, 2800);
}

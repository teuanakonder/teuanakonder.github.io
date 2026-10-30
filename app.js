/**
 * БАЗОВАЯ КОНФИГУРАЦИЯ КУРСОВ И ТАБЛИЦ
 * Вы можете добавлять новые курсы прямо через Админ-панель на сайте!
 */
const DEFAULT_COURSES = [
  {
    id: 'course-3-ofo',
    name: '3 курс (ОФО)',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + '1AkCRgvmlPlkq6XYNdNSkPzhcZm3eI-Xu2c2kabK0Avg',
    groups: [
      '241Р01 ИНФ',
      '241Р71 Эконом',
      '241Р91 Архитектура',
      '241Р111 Дизайн',
      '241Р11 ПГС',
      '241Р31 ЭН',
      '241Р21 УЗС',
      '241Р41 ТМС',
      '241Р61 НТТС'
    ]
  }
];

const STORAGE_KEY_COURSES = 'schedule_portal_courses_v2';
const STORAGE_KEY_SELECTED_COURSE = 'schedule_portal_selected_course';
const STORAGE_KEY_SELECTED_GROUP = 'schedule_portal_selected_group';

let coursesConfig = [];
let currentCourse = null;
let currentGroup = '';
let currentFilter = 'all';
let cachedScheduleData = [];

// 1. Загрузка и сохранение конфигурации курсов
function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COURSES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        coursesConfig = parsed;
        return;
      }
    }
  } catch (e) {
    console.warn('Ошибка чтения localStorage, используем стандартный конфиг');
  }
  coursesConfig = JSON.parse(JSON.stringify(DEFAULT_COURSES));
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY_COURSES, JSON.stringify(coursesConfig));
}

// Извлечение базового URL таблицы из любой ссылки Google Sheets
function normalizeSheetBaseUrl(inputUrl) {
  const trimmed = inputUrl.trim();
  const match = trimmed.match(/https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    return `https://docs.google.com/spreadsheets/d/${match[1]}`;
  }
  return null;
}

// 2. Расчёт числителя и знаменателя
// Опорная дата: неделя с пятницей 30 октября 2026 г. (понедельник 26 октября 2026 г.) = ЧИСЛИТЕЛЬ
function getWeekParity(date = new Date()) {
  const anchorMonday = new Date(2026, 9, 26, 0, 0, 0);
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfWeek = (current.getDay() + 6) % 7; // 0 = Понедельник ... 6 = Воскресенье
  const currentMonday = new Date(current);
  currentMonday.setDate(current.getDate() - dayOfWeek);

  const diffWeeks = Math.round((currentMonday - anchorMonday) / (7 * 24 * 60 * 60 * 1000));
  const isNumerator = Math.abs(diffWeeks % 2) === 0;

  return {
    thisWeek: isNumerator ? 'numerator' : 'denominator',
    nextWeek: isNumerator ? 'denominator' : 'numerator',
    dayIndex: dayOfWeek
  };
}

function renderWeekBanners() {
  const now = new Date();
  const parity = getWeekParity(now);
  const daysRu = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('current-date-badge').textContent = `${daysRu[now.getDay()]}, ${dateStr}`;

  const thisBanner = document.getElementById('this-week-banner');
  const thisLabel = document.getElementById('this-week-label');
  const nextBanner = document.getElementById('next-week-banner');
  const nextLabel = document.getElementById('next-week-label');

  if (parity.thisWeek === 'numerator') {
    thisBanner.className = 'px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-2 bg-white text-slate-900 border border-slate-200 shadow-md';
    thisLabel.textContent = 'ЧИСЛИТЕЛЬ (Белая)';
    nextBanner.className = 'px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-2 bg-blue-600 text-white border border-blue-400 shadow-md';
    nextLabel.textContent = 'ЗНАМЕНАТЕЛЬ (Синяя)';
  } else {
    thisBanner.className = 'px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-2 bg-blue-600 text-white border border-blue-400 shadow-md';
    thisLabel.textContent = 'ЗНАМЕНАТЕЛЬ (Синяя)';
    nextBanner.className = 'px-3.5 py-2 rounded-xl text-xs font-medium flex items-center gap-2 bg-white text-slate-900 border border-slate-200 shadow-md';
    nextLabel.textContent = 'ЧИСЛИТЕЛЬ (Белая)';
  }
}

// 3. Загрузка данных из Google Таблицы через JSONP (работает без CORS на GitHub Pages)
function fetchSheetData(baseSheetUrl, sheetName) {
  return new Promise((resolve, reject) => {
    const callbackName = 'gvizCb_' + Math.random().toString(36).substring(2, 9);
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Превышено время ожидания ответа от таблицы'));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = function (response) {
      cleanup();
      if (response && response.status === 'ok' && response.table) {
        resolve(response.table);
      } else {
        reject(new Error('Лист не найден или доступ к таблице ограничен'));
      }
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('Ошибка подключения к Google Таблицам'));
    };

    script.src = `${baseSheetUrl}/gviz/tq?tqx=out:json;responseHandler:${callbackName}&sheet=${encodeURIComponent(sheetName)}`;
    document.body.appendChild(script);
  });
}

// 4. Парсер объединённых ячеек (1-я строка времени — Числитель, 2-я строка — Знаменатель)
function parseScheduleTable(table) {
  const rawRows = (table.rows || []).map(r =>
    (r.c || []).map(cell => (cell && cell.v !== null && cell.v !== undefined) ? String(cell.v).trim() : '')
  );

  const validDays = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const daysMap = new Map();

  let currentDay = '';
  let lastTime = '';
  let slotCounter = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const colDay = (row[0] || '').trim();
    const colTime = (row[1] || '').trim();
    const colChange = (row[2] || '').trim();
    const colSubject = (row[3] || '').trim();
    const colTeacher = (row[4] || '').trim();
    const colRoom = (row[5] || '').trim();
    const colType = (row[6] || '').trim();

    if (colDay && validDays.includes(colDay.toLowerCase())) {
      currentDay = colDay.charAt(0).toUpperCase() + colDay.slice(1).toLowerCase();
      if (!daysMap.has(currentDay)) {
        daysMap.set(currentDay, []);
      }
    }

    if (!currentDay) continue;

    const timeRegex = /\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}/;
    if (colTime && timeRegex.test(colTime)) {
      if (colTime !== lastTime) {
        lastTime = colTime;
        slotCounter = 0;
      } else {
        slotCounter = 1;
      }
    } else if (lastTime) {
      slotCounter = 1;
    } else {
      continue;
    }

    const daySlots = daysMap.get(currentDay);
    let timeEntry = daySlots.find(item => item.time === lastTime);
    if (!timeEntry) {
      timeEntry = {
        time: lastTime,
        numerator: null,
        denominator: null
      };
      daySlots.push(timeEntry);
    }

    const lessonData = {
      changes: colChange,
      subject: colSubject,
      teacher: colTeacher,
      room: colRoom,
      type: colType
    };

    if (slotCounter === 0 && !timeEntry.numerator) {
      timeEntry.numerator = lessonData;
    } else {
      timeEntry.denominator = lessonData;
    }
  }

  return Array.from(daysMap.entries()).map(([day, slots]) => ({ day, slots }));
}

// 5. Отрисовка карточек расписания
function renderHalfCard(lesson, parityType) {
  const isNumerator = parityType === 'numerator';
  const badgeLabel = isNumerator ? 'Числитель' : 'Знаменатель';
  const cardClass = isNumerator ? 'card-numerator' : 'card-denominator';
  const subTextClass = isNumerator ? 'text-slate-600' : 'text-blue-100';
  const mutedBadgeClass = isNumerator
    ? 'bg-slate-100 text-slate-800 border border-slate-300'
    : 'bg-blue-900/70 text-blue-100 border border-blue-400/40';

  const hasContent = lesson && (lesson.subject || lesson.changes);

  return `
    <div class="${cardClass} rounded-2xl p-4 flex flex-col justify-between min-h-[104px]">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-md ${mutedBadgeClass}">
          ${badgeLabel}
        </span>
        ${lesson && lesson.type ? `
          <span class="text-xs font-extrabold px-2 py-0.5 rounded-md ${isNumerator ? 'bg-slate-900 text-white' : 'bg-white text-blue-900'}">
            ${lesson.type}
          </span>
        ` : ''}
      </div>

      ${hasContent ? `
        <div class="space-y-1.5 my-auto">
          ${lesson.subject ? `<div class="font-bold text-sm sm:text-[15px] leading-snug">${lesson.subject}</div>` : ''}
          ${lesson.changes ? `
            <div class="text-xs font-semibold px-2.5 py-1 rounded-lg ${isNumerator ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-amber-400/20 text-amber-100 border border-amber-300/40'}">
              ⚡ Изменение: ${lesson.changes}
            </div>
          ` : ''}
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 mt-3 pt-2 border-t ${isNumerator ? 'border-slate-200' : 'border-blue-400/30'} text-xs font-medium ${subTextClass}">
          <span>${lesson.teacher ? `👤 ${lesson.teacher}` : ''}</span>
          <span>${lesson.room ? `🚪 Каб. ${lesson.room}` : ''}</span>
        </div>
      ` : `
        <div class="text-xs italic opacity-55 my-auto">Свободная пара (окно)</div>
      `}
    </div>
  `;
}

function renderSchedule() {
  const container = document.getElementById('schedule-container');

  if (!cachedScheduleData.length) {
    container.innerHTML = `
      <div class="glass-panel rounded-3xl p-10 text-center text-slate-400 day-card-animate">
        Для группы <strong class="text-white">${currentGroup}</strong> расписание в таблице пока не заполнено.
      </div>
    `;
    return;
  }

  container.innerHTML = cachedScheduleData.map((dayBlock, index) => {
    const delayMs = index * 70;
    const slotsHtml = dayBlock.slots.map(slot => {
      const numCard = (currentFilter === 'all' || currentFilter === 'numerator')
        ? renderHalfCard(slot.numerator, 'numerator')
        : '';
      const denCard = (currentFilter === 'all' || currentFilter === 'denominator')
        ? renderHalfCard(slot.denominator, 'denominator')
        : '';

      const gridCols = currentFilter === 'all' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1';

      return `
        <div class="p-3.5 sm:p-4 bg-slate-900/65 hover:bg-slate-900/85 transition rounded-2xl border border-slate-800/90 flex flex-col lg:flex-row gap-4 items-stretch lg:items-center">
          <div class="lg:w-36 shrink-0 flex lg:flex-col justify-between lg:justify-center items-center lg:items-start px-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Время пары</span>
            <span class="text-base font-extrabold text-white mt-0.5">${slot.time}</span>
          </div>
          <div class="flex-1 grid ${gridCols} gap-3.5">
            ${numCard}
            ${denCard}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="animation-delay: ${delayMs}ms" class="day-card-animate glass-panel rounded-3xl p-4 sm:p-6">
        <div class="flex items-center justify-between mb-4 pb-3 border-b border-slate-700/70">
          <h2 class="text-lg sm:text-xl font-extrabold text-white flex items-center gap-3">
            <span class="w-2.5 h-6 rounded-full bg-indigo-500 inline-block shadow-sm shadow-indigo-500/50"></span>
            ${dayBlock.day}
          </h2>
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
            ${dayBlock.slots.length} пар(ы)
          </span>
        </div>
        <div class="space-y-3.5">
          ${slotsHtml}
        </div>
      </div>
    `;
  }).join('');
}

// 6. Управление селекторами Курса и Группы
function populateCourseAndGroupSelects() {
  const courseSelect = document.getElementById('course-select');
  const groupSelect = document.getElementById('group-select');
  const courseBadge = document.getElementById('course-badge');

  courseSelect.innerHTML = coursesConfig.map(c =>
    `<option value="${c.id}">${c.name}</option>`
  ).join('');

  const savedCourseId = localStorage.getItem(STORAGE_KEY_SELECTED_COURSE);
  currentCourse = coursesConfig.find(c => c.id === savedCourseId) || coursesConfig[0];
  courseSelect.value = currentCourse.id;
  courseBadge.textContent = currentCourse.name.toUpperCase();

  populateGroupSelect();
}

function populateGroupSelect() {
  const groupSelect = document.getElementById('group-select');
  const groups = currentCourse ? currentCourse.groups : [];

  groupSelect.innerHTML = groups.map(g =>
    `<option value="${g}">${g}</option>`
  ).join('');

  const savedGroup = localStorage.getItem(STORAGE_KEY_SELECTED_GROUP);
  currentGroup = groups.includes(savedGroup) ? savedGroup : (groups[0] || '');
  groupSelect.value = currentGroup;
}

async function loadCurrentSchedule() {
  if (!currentCourse || !currentGroup) return;
  const statusEl = document.getElementById('status-message');
  statusEl.innerHTML = `<span class="loader-dot"></span><span>Загрузка расписания «${currentGroup}» (${currentCourse.name})...</span>`;

  try {
    const table = await fetchSheetData(currentCourse.sheetUrl, currentGroup);
    cachedScheduleData = parseScheduleTable(table);
    statusEl.innerHTML = `<span class="text-emerald-400">●</span><span>Актуально: ${currentCourse.name} • ${currentGroup}</span>`;
    renderSchedule();
  } catch (err) {
    console.error(err);
    statusEl.innerHTML = `<span class="text-rose-400">●</span><span>Ошибка: не найден лист «${currentGroup}» или таблица закрыта</span>`;
  }
}

// 7. Логика Админ-панели
function renderAdminCoursesList() {
  const listEl = document.getElementById('admin-courses-list');
  listEl.innerHTML = coursesConfig.map(course => `
    <div class="p-3.5 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <div class="font-bold text-sm text-white">${course.name}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">
          Групп: ${course.groups.length} (${course.groups.join(', ')})
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button data-edit-id="${course.id}" class="edit-course-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">
          ✏️ Изменить
        </button>
        ${coursesConfig.length > 1 ? `
          <button data-delete-id="${course.id}" class="delete-course-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-950/60 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-800/50 transition">
            🗑️
          </button>
        ` : ''}
      </div>
    </div>
  `).join('');

  // Обработчики редактирования и удаления
  listEl.querySelectorAll('.edit-course-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = coursesConfig.find(c => c.id === btn.dataset.editId);
      if (!target) return;
      document.getElementById('admin-course-name').value = target.name;
      document.getElementById('admin-sheet-url').value = target.sheetUrl;
      document.getElementById('admin-groups-list').value = target.groups.join(', ');
    });
  });

  listEl.querySelectorAll('.delete-course-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      coursesConfig = coursesConfig.filter(c => c.id !== btn.dataset.deleteId);
      saveConfig();
      populateCourseAndGroupSelects();
      renderAdminCoursesList();
      loadCurrentSchedule();
    });
  });
}

function showAdminFeedback(message, isSuccess = true) {
  const box = document.getElementById('admin-feedback');
  box.classList.remove('hidden');
  box.className = `text-xs font-semibold rounded-xl p-3 ${
    isSuccess
      ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
      : 'bg-rose-500/20 text-rose-200 border border-rose-500/40'
  }`;
  box.textContent = message;
}

// 8. Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  renderWeekBanners();
  populateCourseAndGroupSelects();
  loadCurrentSchedule();

  // Переключение курса
  document.getElementById('course-select').addEventListener('change', (e) => {
    const selected = coursesConfig.find(c => c.id === e.target.value);
    if (!selected) return;
    currentCourse = selected;
    localStorage.setItem(STORAGE_KEY_SELECTED_COURSE, currentCourse.id);
    document.getElementById('course-badge').textContent = currentCourse.name.toUpperCase();
    populateGroupSelect();
    loadCurrentSchedule();
  });

  // Переключение группы
  document.getElementById('group-select').addEventListener('change', (e) => {
    currentGroup = e.target.value;
    localStorage.setItem(STORAGE_KEY_SELECTED_GROUP, currentGroup);
    loadCurrentSchedule();
  });

  // Кнопки фильтрации недель
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active-filter'));
      btn.classList.add('active-filter');
      renderSchedule();
    });
  });

  // Открытие / закрытие Админ-панели
  const modal = document.getElementById('admin-modal');
  document.getElementById('open-admin-btn').addEventListener('click', () => {
    renderAdminCoursesList();
    modal.classList.remove('hidden');
  });

  document.getElementById('close-admin-btn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Проверка связи с таблицей в Админ-панели
  document.getElementById('test-sheet-btn').addEventListener('click', async () => {
    const rawUrl = document.getElementById('admin-sheet-url').value;
    const rawGroups = document.getElementById('admin-groups-list').value;
    const baseUrl = normalizeSheetBaseUrl(rawUrl);
    const firstGroup = rawGroups.split(',').map(s => s.trim()).filter(Boolean)[0];

    if (!baseUrl || !firstGroup) {
      showAdminFeedback('Укажите корректную ссылку на Google Таблицу и хотя бы одну группу.', false);
      return;
    }

    showAdminFeedback(`Проверяем доступ к листу «${firstGroup}»...`, true);
    try {
      await fetchSheetData(baseUrl, firstGroup);
      showAdminFeedback(`Успешно! Таблица доступна, лист «${firstGroup}» прочитан корректно.`, true);
    } catch (err) {
      showAdminFeedback(`Не удалось прочитать лист «${firstGroup}». Проверьте название вкладки и открыт ли доступ по ссылке.`, false);
    }
  });

  // Сохранение курса или обновление существующего
  document.getElementById('admin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('admin-course-name').value.trim();
    const rawUrl = document.getElementById('admin-sheet-url').value.trim();
    const rawGroups = document.getElementById('admin-groups-list').value;

    const baseUrl = normalizeSheetBaseUrl(rawUrl);
    const groups = rawGroups.split(',').map(g => g.trim()).filter(Boolean);

    if (!baseUrl) {
      showAdminFeedback('Некорректная ссылка на Google Таблицу.', false);
      return;
    }
    if (!groups.length) {
      showAdminFeedback('Добавьте хотя бы одну группу через запятую.', false);
      return;
    }

    const existingIndex = coursesConfig.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    if (existingIndex >= 0) {
      coursesConfig[existingIndex].sheetUrl = baseUrl;
      coursesConfig[existingIndex].groups = groups;
      currentCourse = coursesConfig[existingIndex];
    } else {
      const newCourse = {
        id: 'course-' + Date.now(),
        name,
        sheetUrl: baseUrl,
        groups
      };
      coursesConfig.push(newCourse);
      currentCourse = newCourse;
    }

    saveConfig();
    localStorage.setItem(STORAGE_KEY_SELECTED_COURSE, currentCourse.id);
    populateCourseAndGroupSelects();
    renderAdminCoursesList();
    loadCurrentSchedule();
    showAdminFeedback(`Курс «${name}» (${groups.length} гр.) успешно сохранён!`, true);
    e.target.reset();
  });

  // Сброс к стандартным настройкам
  document.getElementById('reset-defaults-btn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY_COURSES);
    loadConfig();
    populateCourseAndGroupSelects();
    renderAdminCoursesList();
    loadCurrentSchedule();
    showAdminFeedback('Настройки сброшены к стандартному 3 курсу.', true);
  });

  // Копирование JSON конфига для вставки в код GitHub Pages
  document.getElementById('copy-config-btn').addEventListener('click', () => {
    const codeSnippet = `const DEFAULT_COURSES = ${JSON.stringify(coursesConfig, null, 2)};`;
    navigator.clipboard.writeText(codeSnippet).then(() => {
      showAdminFeedback('Код DEFAULT_COURSES скопирован в буфер обмена! Замените им блок в начале app.js.', true);
    });
  });
});

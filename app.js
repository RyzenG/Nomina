const form = document.getElementById("shift-form");
const errorsEl = document.getElementById("form-errors");
const tableBody = document.getElementById("results-body");
const resetButton = document.getElementById("reset");
const weekFilter = document.getElementById("week-filter");
const weekInput = form.week;
const shiftSpanSelect = document.getElementById("shift-span");
const weeklyHoursList = document.getElementById("weekly-hours-list");
const totalsEls = {
  rn: document.getElementById("total-rn"),
  hed: document.getElementById("total-hed"),
  hedf: document.getElementById("total-hedf"),
  hen: document.getElementById("total-hen"),
  hours: document.getElementById("total-hours"),
};

const records = [];
const weeklyOrdinaryMinutes = new Map();

const DAYS = [
  { key: "sunday", label: "Domingo" },
  { key: "monday", label: "Lunes" },
  { key: "tuesday", label: "Martes" },
  { key: "wednesday", label: "Miércoles" },
  { key: "thursday", label: "Jueves" },
  { key: "friday", label: "Viernes" },
  { key: "saturday", label: "Sábado" },
];

const DAY_OFFSETS = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: -1,
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorsEl.textContent = "";

  const weekOverride = form.week.value ? form.week.value.trim() : null;
  const scheduleEntries = [];

  for (const day of DAYS) {
    const startField = form[`day-${day.key}-start`];
    const endField = form[`day-${day.key}-end`];
    const typeField = form[`day-${day.key}-type`];

    const startRaw = startField.value;
    const endRaw = endField.value;
    const dayType = typeField.value;

    if (!startRaw && !endRaw) {
      continue;
    }

    if (!startRaw || !endRaw) {
      errorsEl.textContent = `Debe indicar la hora de inicio y fin para ${day.label}.`;
      return;
    }

    const startDate = new Date(startRaw);
    const endDate = new Date(endRaw);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      errorsEl.textContent = `Las fechas indicadas para ${day.label} no son válidas.`;
      return;
    }

    if (endDate <= startDate) {
      errorsEl.textContent = `La hora de fin debe ser posterior a la de inicio en ${day.label}.`;
      return;
    }

    scheduleEntries.push({ start: startDate, end: endDate, dayType });
  }

  if (scheduleEntries.length === 0) {
    errorsEl.textContent = "Registre al menos un día con horario válido.";
    return;
  }

  for (const entry of scheduleEntries) {
    const calculation = calculateShift({
      start: entry.start,
      end: entry.end,
      dayTypeOverride: entry.dayType,
      weekOverride,
    });

    const entries = Object.entries(calculation.minutesByDay).map(
      ([dayKey, values]) => {
        const [year, month, day] = dayKey
          .split("-")
          .map((part) => Number.parseInt(part, 10));
        const dayDate = new Date(year, month - 1, day);
        return {
          dayKey,
          week: resolveWeekKey(dayDate, weekOverride),
          values: { ...values },
        };
      }
    );

    records.push({
      start: entry.start,
      end: entry.end,
      minutesByDay: calculation.minutesByDay,
      entries,
      totals: calculation.totals,
    });
  }

  updateFilters();
  updateTable();
  updateSummary();
  form.reset();
});

resetButton.addEventListener("click", () => {
  records.length = 0;
  weeklyOrdinaryMinutes.clear();
  updateFilters();
  updateTable();
  updateSummary();
  form.reset();
  errorsEl.textContent = "";
});

weekFilter.addEventListener("change", handleFilterChange);
weekInput.addEventListener("change", handleWeekSelectionChange);
shiftSpanSelect.addEventListener("change", handleShiftSpanChange);

function calculateShift({
  start,
  end,
  dayTypeOverride,
  weekOverride = null,
}) {
  const WEEKLY_ORDINARY_LIMIT = 2640; // 44 horas semanales.

  let segments = splitIntoSegments(start, end);
  segments = applyAutomaticRest(segments);

  const dayOrdinaryBudget = new Map();
  const totals = {
    ordinary: 0,
    rn: 0,
    hed: 0,
    hedf: 0,
    hen: 0,
  };
  const minutesByDay = new Map();

  const ensureDayTotals = (dayKey) => {
    if (!minutesByDay.has(dayKey)) {
      minutesByDay.set(dayKey, {
        ordinary: 0,
        rn: 0,
        hed: 0,
        hedf: 0,
        hen: 0,
      });
    }
    return minutesByDay.get(dayKey);
  };

  for (const segment of segments) {
    const minutes = differenceInMinutes(segment.start, segment.end);
    if (minutes <= 0) continue;

    const { dayKey, dayDate } = getLocalDayKey(segment.start);
    const dayType = resolveDayType(segment.start, dayTypeOverride);
    const isDiurnal = isDiurnalSegment(segment);
    const weekKey = resolveWeekKey(dayDate, weekOverride);
    const dayTotals = ensureDayTotals(dayKey);

    if (!dayOrdinaryBudget.has(dayKey)) {
      dayOrdinaryBudget.set(dayKey, 480); // 8 horas diarias estándar.
    }

    let budget = dayOrdinaryBudget.get(dayKey);

    if (dayType === "ordinario") {
      let weeklyUsed = weeklyOrdinaryMinutes.get(weekKey) ?? 0;
      let weeklyRemaining = Math.max(0, WEEKLY_ORDINARY_LIMIT - weeklyUsed);
      let usableWeekly = Math.min(minutes, weeklyRemaining);
      let usable = Math.min(usableWeekly, budget);

      if (!isDiurnal && usable < minutes) {
        const reclaimNeeded = minutes - usable;
        const reclaimable = Math.min(
          dayTotals.ordinary,
          reclaimNeeded,
          weeklyUsed
        );

        if (reclaimable > 0) {
          dayTotals.ordinary -= reclaimable;
          dayTotals.hed += reclaimable;
          totals.ordinary -= reclaimable;
          totals.hed += reclaimable;

          budget += reclaimable;
          weeklyUsed -= reclaimable;
          weeklyOrdinaryMinutes.set(weekKey, weeklyUsed);

          weeklyRemaining = Math.max(0, WEEKLY_ORDINARY_LIMIT - weeklyUsed);
          usableWeekly = Math.min(minutes, weeklyRemaining);
          usable = Math.min(usableWeekly, budget);
        }
      }

      const remaining = minutes - usable;

      if (isDiurnal) {
        totals.ordinary += usable;
        dayTotals.ordinary += usable;
        if (remaining > 0) {
          totals.hed += remaining;
          dayTotals.hed += remaining;
        }
      } else {
        totals.rn += usable;
        dayTotals.rn += usable;
        if (remaining > 0) {
          totals.hen += remaining;
          dayTotals.hen += remaining;
        }
      }

      budget = Math.max(0, budget - usable);
      dayOrdinaryBudget.set(dayKey, budget);
      weeklyOrdinaryMinutes.set(weekKey, weeklyUsed + usable);
    } else {
      // Para jornadas dominicales o festivas mantenemos las horas diurnas como HEDF
      // pero las nocturnas se contabilizan como RN para reflejar el recargo nocturno
      // esperado en escenarios como domingo 19:00 a lunes 05:00.
      if (isDiurnal) {
        if (dayType === "dominical") {
          const usable = Math.min(minutes, budget);
          const remaining = minutes - usable;

          if (usable > 0) {
            totals.ordinary += usable;
            dayTotals.ordinary += usable;
            budget = Math.max(0, budget - usable);
            dayOrdinaryBudget.set(dayKey, budget);
          }

          if (remaining > 0) {
            totals.hedf += remaining;
            dayTotals.hedf += remaining;
          }
        } else {
          totals.hedf += minutes;
          dayTotals.hedf += minutes;
        }
      } else {
        totals.rn += minutes;
        dayTotals.rn += minutes;
      }
    }
  }

  const minutesByDayObject = Object.fromEntries(
    Array.from(minutesByDay.entries()).map(([day, values]) => [day, { ...values }])
  );

  return {
    start,
    end,
    dayType: resolveDayType(start, dayTypeOverride, true),
    totals,
    minutesByDay: minutesByDayObject,
  };
}

function splitIntoSegments(start, end) {
  const segments = [];
  let cursor = new Date(start);

  while (cursor < end) {
    const boundary = nextBoundary(cursor);
    const segmentEnd = boundary < end ? boundary : end;
    segments.push({ start: new Date(cursor), end: new Date(segmentEnd) });
    cursor = segmentEnd;
  }

  return segments;
}

function applyAutomaticRest(segments) {
  if (segments.length === 0) {
    return segments;
  }

  const totalMinutes = segments.reduce(
    (acc, segment) => acc + differenceInMinutes(segment.start, segment.end),
    0
  );

  if (totalMinutes < 480) {
    return segments;
  }

  const shiftStartMs = segments[0].start.getTime();
  const shiftEndMs = segments[segments.length - 1].end.getTime();
  const shiftDurationMs = shiftEndMs - shiftStartMs;
  const restDurationMs = 60 * 60000;

  let restStartMs = shiftStartMs + (shiftDurationMs - restDurationMs) / 2;
  restStartMs = Math.max(shiftStartMs, Math.min(restStartMs, shiftEndMs - restDurationMs));
  const restEndMs = restStartMs + restDurationMs;

  return removeRestFromSegments(
    segments,
    new Date(restStartMs),
    new Date(restEndMs)
  );
}

function removeRestFromSegments(segments, restStart, restEnd) {
  if (!restStart || !restEnd) {
    return segments;
  }

  const restStartMs = restStart.getTime();
  const restEndMs = restEnd.getTime();
  const trimmed = [];

  for (const segment of segments) {
    const segmentStartMs = segment.start.getTime();
    const segmentEndMs = segment.end.getTime();

    const overlapStart = Math.max(segmentStartMs, restStartMs);
    const overlapEnd = Math.min(segmentEndMs, restEndMs);

    if (overlapStart >= overlapEnd) {
      trimmed.push({
        start: new Date(segmentStartMs),
        end: new Date(segmentEndMs),
      });
      continue;
    }

    if (segmentStartMs < overlapStart) {
      trimmed.push({
        start: new Date(segmentStartMs),
        end: new Date(overlapStart),
      });
    }

    if (overlapEnd < segmentEndMs) {
      trimmed.push({
        start: new Date(overlapEnd),
        end: new Date(segmentEndMs),
      });
    }
  }

  return trimmed;
}

function nextBoundary(date) {
  const candidates = [];

  const sameDaySix = new Date(date);
  sameDaySix.setHours(6, 0, 0, 0);
  if (sameDaySix > date) {
    candidates.push(sameDaySix);
  }

  const sameDayTwentyOne = new Date(date);
  sameDayTwentyOne.setHours(21, 0, 0, 0);
  if (sameDayTwentyOne > date) {
    candidates.push(sameDayTwentyOne);
  }

  const midnight = new Date(date);
  midnight.setHours(24, 0, 0, 0);
  if (midnight > date) {
    candidates.push(midnight);
  }

  const nextDaySix = new Date(midnight);
  nextDaySix.setHours(6, 0, 0, 0);
  if (nextDaySix > date) {
    candidates.push(nextDaySix);
  }

  candidates.sort((a, b) => a - b);
  return candidates[0];
}

function resolveDayType(date, override, labelMode = false) {
  if (override && override !== "auto") {
    return labelMode ? capitalize(override) : override;
  }

  const day = date.getDay();
  if (day === 0) {
    return labelMode ? "Dominical" : "dominical";
  }
  return labelMode ? "Ordinario" : "ordinario";
}

function isDiurnalSegment(segment) {
  const hour = segment.start.getHours();
  const minutes = segment.start.getMinutes();
  const totalMinutes = hour * 60 + minutes;
  return totalMinutes >= 360 && totalMinutes < 1260; // 06:00 a 21:00
}

function differenceInMinutes(start, end) {
  return (end - start) / 60000;
}

function toHours(minutes) {
  return Math.round((minutes / 60) * 100) / 100;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function updateTable() {
  tableBody.innerHTML = "";

  const filtered = getFilteredRecords();
  const weekFilterValue = weekFilter.value;

  if (filtered.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty";
    cell.textContent = "No hay jornadas para los filtros seleccionados.";
    row.append(cell);
    tableBody.append(row);
    return;
  }

  const grouped = new Map();
  let hasRows = false;

  for (const record of filtered) {
    const relevantEntries = weekFilterValue
      ? record.entries.filter((entry) => entry.week === weekFilterValue)
      : record.entries;

    for (const entry of relevantEntries) {
      if (!grouped.has(entry.week)) {
        grouped.set(entry.week, new Map());
      }

      const dayMap = grouped.get(entry.week);

      if (!dayMap.has(entry.dayKey)) {
        dayMap.set(entry.dayKey, {
          ordinary: 0,
          rn: 0,
          hed: 0,
          hedf: 0,
          hen: 0,
        });
      }

      const accumulator = dayMap.get(entry.dayKey);
      const values = entry.values;
      accumulator.ordinary += values.ordinary ?? 0;
      accumulator.rn += values.rn ?? 0;
      accumulator.hed += values.hed ?? 0;
      accumulator.hedf += values.hedf ?? 0;
      accumulator.hen += values.hen ?? 0;
    }
  }

  const sortedWeeks = Array.from(grouped.keys()).sort();

  for (const week of sortedWeeks) {
    const days = grouped.get(week);
    const sortedDays = Array.from(days.keys()).sort();

    for (const dayKey of sortedDays) {
      const values = days.get(dayKey);
      const rnHours = toHours(values.rn);
      const hedHours = toHours(values.hed);
      const hedfHours = toHours(values.hedf);
      const henHours = toHours(values.hen);
      const totalHours = toHours(
        values.ordinary + values.rn + values.hed + values.hedf + values.hen
      );

      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${week}</td>
        <td>${formatDayLabel(dayKey)}</td>
        <td>${rnHours.toFixed(2)}</td>
        <td>${hedHours.toFixed(2)}</td>
        <td>${hedfHours.toFixed(2)}</td>
        <td>${henHours.toFixed(2)}</td>
        <td>${totalHours.toFixed(2)}</td>
      `;

      tableBody.append(row);
      hasRows = true;
    }
  }

  if (!hasRows) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "empty";
    cell.textContent = "No hay jornadas para los filtros seleccionados.";
    row.append(cell);
    tableBody.append(row);
  }
}

function updateSummary() {
  const filtered = getFilteredRecords();
  const weekFilterValue = weekFilter.value;
  const totals = { rn: 0, hed: 0, hedf: 0, hen: 0, ordinary: 0 };
  const weeklyTotals = new Map();

  for (const record of filtered) {
    const relevantEntries = weekFilterValue
      ? record.entries.filter((entry) => entry.week === weekFilterValue)
      : record.entries;

    for (const entry of relevantEntries) {
      const values = entry.values;
      const weekKey = entry.week;

      totals.rn += values.rn ?? 0;
      totals.hed += values.hed ?? 0;
      totals.hedf += values.hedf ?? 0;
      totals.hen += values.hen ?? 0;
      totals.ordinary += values.ordinary ?? 0;

      if (!weeklyTotals.has(weekKey)) {
        weeklyTotals.set(weekKey, {
          rn: 0,
          hed: 0,
          hedf: 0,
          hen: 0,
          ordinary: 0,
        });
      }

      const accumulator = weeklyTotals.get(weekKey);
      accumulator.rn += values.rn ?? 0;
      accumulator.hed += values.hed ?? 0;
      accumulator.hedf += values.hedf ?? 0;
      accumulator.hen += values.hen ?? 0;
      accumulator.ordinary += values.ordinary ?? 0;
    }
  }

  totalsEls.rn.textContent = toHours(totals.rn).toFixed(2);
  totalsEls.hed.textContent = toHours(totals.hed).toFixed(2);
  totalsEls.hedf.textContent = toHours(totals.hedf).toFixed(2);
  totalsEls.hen.textContent = toHours(totals.hen).toFixed(2);

  const totalHours = toHours(totals.rn + totals.hed + totals.hedf + totals.hen + totals.ordinary);
  totalsEls.hours.textContent = totalHours.toFixed(2);

  updateWeeklyHoursList(weeklyTotals);
}

function getFilteredRecords() {
  return records.filter((record) => {
    if (weekFilter.value) {
      return record.entries.some((entry) => entry.week === weekFilter.value);
    }
    return true;
  });
}

function updateFilters() {
  const weekSet = new Set();
  records.forEach((record) => {
    record.entries.forEach((entry) => {
      weekSet.add(entry.week);
    });
  });

  updateSelectOptions(
    weekFilter,
    Array.from(weekSet).sort(),
    "Todas las semanas"
  );
}

function updateSelectOptions(selectEl, values, defaultLabel) {
  const previousValue = selectEl.value;
  selectEl.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = defaultLabel;
  selectEl.append(defaultOption);

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.append(option);
  });

  if (values.includes(previousValue)) {
    selectEl.value = previousValue;
  } else {
    selectEl.value = "";
  }
}

function handleFilterChange() {
  updateTable();
  updateSummary();
}

function handleWeekSelectionChange() {
  const weekValue = weekInput.value ? weekInput.value.trim() : "";
  if (!weekValue) {
    return;
  }
  applyWeekSelection(weekValue);
}

function handleShiftSpanChange() {
  const weekValue = weekInput.value ? weekInput.value.trim() : "";
  if (!weekValue) {
    return;
  }
  applyWeekSelection(weekValue);
}

function applyWeekSelection(weekValue) {
  const baseDates = getDatesForISOWeek(weekValue);
  if (!baseDates) {
    return;
  }

  for (const day of DAYS) {
    const baseDate = baseDates[day.key];
    if (!baseDate) continue;

    const startField = form[`day-${day.key}-start`];
    const endField = form[`day-${day.key}-end`];

    setFieldDate(startField, baseDate);

    const endDate = new Date(baseDate);
    if (shiftSpanSelect.value === "pm") {
      endDate.setDate(endDate.getDate() + 1);
    }

    setFieldDate(endField, endDate);
  }
}

function getDatesForISOWeek(weekValue) {
  const match = weekValue.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const weekNumber = Number.parseInt(match[2], 10);

  const fourthOfJanuary = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = fourthOfJanuary.getUTCDay() || 7;
  const isoWeekStartUtc = new Date(fourthOfJanuary);
  isoWeekStartUtc.setUTCDate(
    fourthOfJanuary.getUTCDate() - (dayOfWeek - 1) + (weekNumber - 1) * 7
  );

  const monday = new Date(
    isoWeekStartUtc.getUTCFullYear(),
    isoWeekStartUtc.getUTCMonth(),
    isoWeekStartUtc.getUTCDate()
  );

  const dates = {};

  for (const day of DAYS) {
    const offset = DAY_OFFSETS[day.key];
    if (typeof offset !== "number") continue;
    const date = new Date(monday);
    date.setDate(monday.getDate() + offset);
    dates[day.key] = date;
  }

  return dates;
}

function setFieldDate(field, date) {
  if (!field || !date) {
    return;
  }

  const isoDate = formatDateForInput(date);
  const timePart = extractTimePart(field.value);
  const newValue = `${isoDate}T${timePart ?? "00:00"}`;
  field.value = newValue;
}

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractTimePart(value) {
  if (!value) {
    return null;
  }
  const parts = value.split("T");
  return parts[1] ?? null;
}

function resolveWeekKey(date, override) {
  if (override) {
    return override;
  }
  return getISOWeek(date);
}

function getLocalDayKey(date) {
  const year = date.getFullYear();
  const monthIndex = date.getMonth();
  const dayNumber = date.getDate();
  const month = String(monthIndex + 1).padStart(2, "0");
  const day = String(dayNumber).padStart(2, "0");

  return {
    dayKey: `${year}-${month}-${day}`,
    dayDate: new Date(year, monthIndex, dayNumber),
  };
}

function getISOWeek(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function formatDayLabel(dayKey) {
  const [year, month, day] = dayKey.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("es-CO", {
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function updateWeeklyHoursList(weeklyTotals) {
  weeklyHoursList.innerHTML = "";

  const entries = Array.from(weeklyTotals.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  if (entries.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "Sin horas registradas para el filtro actual.";
    weeklyHoursList.append(item);
    return;
  }

  for (const [week, values] of entries) {
    const totalMinutes =
      (values.rn ?? 0) +
      (values.hed ?? 0) +
      (values.hedf ?? 0) +
      (values.hen ?? 0) +
      (values.ordinary ?? 0);

    const totalHours = toHours(totalMinutes).toFixed(2);
    const ordinaryHours = toHours(values.ordinary ?? 0).toFixed(2);
    const rnHours = toHours(values.rn ?? 0).toFixed(2);
    const hedHours = toHours(values.hed ?? 0).toFixed(2);
    const hedfHours = toHours(values.hedf ?? 0).toFixed(2);
    const henHours = toHours(values.hen ?? 0).toFixed(2);

    const item = document.createElement("li");
    item.innerHTML = `
      <div class="week-row">
        <span>${week}</span>
        <span>${totalHours} h</span>
      </div>
      <div class="week-detail">
        Ord: ${ordinaryHours} h · RN: ${rnHours} h · HED: ${hedHours} h · HEDF: ${hedfHours} h · HEN: ${henHours} h
      </div>
    `;
    weeklyHoursList.append(item);
  }
}

function logManualExamples() {
  if (typeof console === "undefined") {
    return;
  }

  const log = typeof console.log === "function" ? console.log.bind(console) : () => {};
  const group = typeof console.group === "function" ? console.group.bind(console) : log;
  const groupEnd = typeof console.groupEnd === "function"
    ? console.groupEnd.bind(console)
    : () => {};

  const originalState = new Map(weeklyOrdinaryMinutes);

  try {
    weeklyOrdinaryMinutes.clear();

    const sundayNight = calculateShift({
      start: new Date("2024-03-03T19:00:00"),
      end: new Date("2024-03-04T05:00:00"),
      dayTypeOverride: "auto",
    });

    group("Prueba manual: descanso automático en jornada dominical");
    log(
      "Horas registradas tras descontar la hora de comida (esperado 9.00 h):",
      toHours(
        sundayNight.totals.ordinary +
          sundayNight.totals.rn +
          sundayNight.totals.hed +
          sundayNight.totals.hedf +
          sundayNight.totals.hen
      ).toFixed(2)
    );
    log("Detalle por día (minutos):", sundayNight.minutesByDay);
    groupEnd();

    const manualWeekKey = getISOWeek(new Date("2024-07-08T08:00:00"));
    weeklyOrdinaryMinutes.set(manualWeekKey, 2640);

    const overtimeNight = calculateShift({
      start: new Date("2024-07-08T22:00:00"),
      end: new Date("2024-07-09T06:00:00"),
      dayTypeOverride: "auto",
      weekOverride: manualWeekKey,
    });

    group("Prueba manual: reclasificación semanal tras 44h");
    log("Totales (minutos):", overtimeNight.totals);
    groupEnd();
  } finally {
    weeklyOrdinaryMinutes.clear();
    for (const [key, value] of originalState.entries()) {
      weeklyOrdinaryMinutes.set(key, value);
    }
  }
}

updateFilters();
updateTable();
updateSummary();

handleWeekSelectionChange();

logManualExamples();

// Pruebas manuales sugeridas:
// 1. Domingo 19:00 a lunes 05:00 y validar que el sistema descuenta automáticamente 60 minutos.
// 2. Registrar varios días en una misma semana y filtrar por semana para comprobar los totales.
// 3. Completar una semana con más de 44 horas ordinarias y confirmar la reclasificación automática.

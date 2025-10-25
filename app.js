const form = document.getElementById("shift-form");
const errorsEl = document.getElementById("form-errors");
const tableBody = document.getElementById("results-body");
const resetButton = document.getElementById("reset");
const personFilter = document.getElementById("person-filter");
const weekFilter = document.getElementById("week-filter");
const totalsEls = {
  rn: document.getElementById("total-rn"),
  hed: document.getElementById("total-hed"),
  hedf: document.getElementById("total-hedf"),
  hen: document.getElementById("total-hen"),
  hours: document.getElementById("total-hours"),
};

const records = [];

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorsEl.textContent = "";

  const person = form.person.value.trim();
  const startRaw = form.start.value;
  const endRaw = form.end.value;
  const dayType = form["day-type"].value;
  const restRaw = form.rest.value;
  const restStartRaw = form["rest-start"].value;
  const restEndRaw = form["rest-end"].value;

  if (!person) {
    errorsEl.textContent = "Debe indicar la persona asociada a la jornada.";
    return;
  }

  if (!startRaw || !endRaw) {
    errorsEl.textContent = "Debe indicar las fechas de inicio y fin de la jornada.";
    return;
  }

  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    errorsEl.textContent = "Las fechas proporcionadas no son válidas.";
    return;
  }

  if (endDate <= startDate) {
    errorsEl.textContent = "La hora de fin debe ser posterior a la de inicio.";
    return;
  }

  const restMinutes = Number.parseInt(restRaw || "0", 10);
  if (Number.isNaN(restMinutes) || restMinutes < 0) {
    errorsEl.textContent = "Los minutos de descanso deben ser un número positivo.";
    return;
  }

  const totalMinutes = (endDate - startDate) / 60000;
  if (restMinutes >= totalMinutes) {
    errorsEl.textContent = "El descanso no puede ser igual o mayor al tiempo total trabajado.";
    return;
  }

  if (restMinutes > 240) {
    errorsEl.textContent = "El descanso no debería exceder las 4 horas (240 minutos).";
    return;
  }

  let restStartDate = null;
  let restEndDate = null;

  if (restMinutes > 0) {
    if (!restStartRaw) {
      errorsEl.textContent = "Debe indicar la hora de inicio del descanso.";
      return;
    }

    restStartDate = new Date(restStartRaw);
    if (Number.isNaN(restStartDate.getTime())) {
      errorsEl.textContent = "La hora de inicio del descanso no es válida.";
      return;
    }

    if (restStartDate < startDate || restStartDate >= endDate) {
      errorsEl.textContent = "El inicio del descanso debe estar dentro de la jornada.";
      return;
    }

    if (restEndRaw) {
      restEndDate = new Date(restEndRaw);
      if (Number.isNaN(restEndDate.getTime())) {
        errorsEl.textContent = "La hora de fin del descanso no es válida.";
        return;
      }
    } else {
      restEndDate = new Date(restStartDate.getTime() + restMinutes * 60000);
    }

    if (restEndDate <= restStartDate) {
      errorsEl.textContent = "El fin del descanso debe ser posterior al inicio.";
      return;
    }

    if (restEndDate > endDate) {
      errorsEl.textContent = "El descanso debe finalizar antes de terminar la jornada.";
      return;
    }

    const restDuration = differenceInMinutes(restStartDate, restEndDate);
    if (Math.abs(restDuration - restMinutes) > 1e-6) {
      errorsEl.textContent = "La duración del descanso no coincide con los minutos indicados.";
      return;
    }
  } else if (restStartRaw || restEndRaw) {
    errorsEl.textContent = "Si no se descansa, no indique horas de inicio o fin de descanso.";
    return;
  }

  const restRange = restMinutes > 0 ? { start: restStartDate, end: restEndDate } : null;

  const calculation = calculateShift({
    start: startDate,
    end: endDate,
    dayTypeOverride: dayType,
    restMinutes,
    restRange,
  });

  const entries = Object.entries(calculation.minutesByDay).map(
    ([dayKey, values]) => {
      const [year, month, day] = dayKey
        .split("-")
        .map((part) => Number.parseInt(part, 10));
      const dayDate = new Date(year, month - 1, day);
      return {
        dayKey,
        week: getISOWeek(dayDate),
        values: { ...values },
      };
    }
  );

  records.push({
    person,
    start: startDate,
    end: endDate,
    minutesByDay: calculation.minutesByDay,
    entries,
    totals: calculation.totals,
  });

  updateFilters();
  updateTable();
  updateSummary();
  form.reset();
});

resetButton.addEventListener("click", () => {
  records.length = 0;
  updateFilters();
  updateTable();
  updateSummary();
  form.reset();
  errorsEl.textContent = "";
});

personFilter.addEventListener("change", handleFilterChange);
weekFilter.addEventListener("change", handleFilterChange);

function calculateShift({ start, end, dayTypeOverride, restMinutes, restRange }) {
  let segments = splitIntoSegments(start, end);
  if (restMinutes > 0 && restRange) {
    segments = removeRestFromSegments(segments, restRange.start, restRange.end);
  }

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

    const dayKey = segment.start.toISOString().slice(0, 10);
    const dayType = resolveDayType(segment.start, dayTypeOverride);
    const isDiurnal = isDiurnalSegment(segment);
    const dayTotals = ensureDayTotals(dayKey);

    if (!dayOrdinaryBudget.has(dayKey)) {
      dayOrdinaryBudget.set(dayKey, 480); // 8 horas diarias estándar.
    }

    if (dayType === "ordinario") {
      const budget = dayOrdinaryBudget.get(dayKey);
      const usable = Math.min(minutes, budget);
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

      dayOrdinaryBudget.set(dayKey, Math.max(0, budget - usable));
    } else {
      // Para jornadas dominicales o festivas tratamos todas las horas diurnas como HEDF
      // y las nocturnas como HEN (recargo nocturno festivo/dom.).
      if (isDiurnal) {
        totals.hedf += minutes;
        dayTotals.hedf += minutes;
      } else {
        totals.hen += minutes;
        dayTotals.hen += minutes;
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

function sumMinutes(record) {
  return Object.values(record || {}).reduce(
    (acc, value) => acc + (value ?? 0),
    0
  );
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
    cell.colSpan = 8;
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

    if (relevantEntries.length === 0) {
      continue;
    }

    if (!grouped.has(record.person)) {
      grouped.set(record.person, new Map());
    }

    const weekMap = grouped.get(record.person);

    for (const entry of relevantEntries) {
      if (!weekMap.has(entry.week)) {
        weekMap.set(entry.week, new Map());
      }

      const dayMap = weekMap.get(entry.week);

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

  const sortedPersons = Array.from(grouped.keys()).sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );

  for (const person of sortedPersons) {
    const weeks = grouped.get(person);
    const sortedWeeks = Array.from(weeks.keys()).sort();

    for (const week of sortedWeeks) {
      const days = weeks.get(week);
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
          <td>${person}</td>
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
  }

  if (!hasRows) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty";
    cell.textContent = "No hay jornadas para los filtros seleccionados.";
    row.append(cell);
    tableBody.append(row);
  }
}

function updateSummary() {
  const filtered = getFilteredRecords();
  const weekFilterValue = weekFilter.value;
  const totals = filtered.reduce(
    (acc, record) => {
      const relevantEntries = weekFilterValue
        ? record.entries.filter((entry) => entry.week === weekFilterValue)
        : record.entries;

      for (const entry of relevantEntries) {
        const values = entry.values;
        acc.rn += values.rn ?? 0;
        acc.hed += values.hed ?? 0;
        acc.hedf += values.hedf ?? 0;
        acc.hen += values.hen ?? 0;
        acc.ordinary += values.ordinary ?? 0;
      }
      return acc;
    },
    { rn: 0, hed: 0, hedf: 0, hen: 0, ordinary: 0 }
  );

  totalsEls.rn.textContent = toHours(totals.rn).toFixed(2);
  totalsEls.hed.textContent = toHours(totals.hed).toFixed(2);
  totalsEls.hedf.textContent = toHours(totals.hedf).toFixed(2);
  totalsEls.hen.textContent = toHours(totals.hen).toFixed(2);

  const totalHours = toHours(totals.rn + totals.hed + totals.hedf + totals.hen + totals.ordinary);
  totalsEls.hours.textContent = totalHours.toFixed(2);
}

function getFilteredRecords() {
  return records.filter((record) => {
    if (personFilter.value && record.person !== personFilter.value) {
      return false;
    }
    if (weekFilter.value) {
      return record.entries.some((entry) => entry.week === weekFilter.value);
    }
    return true;
  });
}

function updateFilters() {
  updateSelectOptions(
    personFilter,
    Array.from(new Set(records.map((record) => record.person))).sort((a, b) =>
      a.localeCompare(b, "es", { sensitivity: "base" })
    ),
    "Todas las personas"
  );

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

function logManualExamples() {
  if (typeof console === "undefined") {
    return;
  }

  const log = typeof console.log === "function" ? console.log.bind(console) : () => {};
  const group = typeof console.group === "function" ? console.group.bind(console) : log;
  const groupEnd = typeof console.groupEnd === "function"
    ? console.groupEnd.bind(console)
    : () => {};

  const beforeTwentyOne = calculateShift({
    start: new Date("2024-05-10T18:00:00"),
    end: new Date("2024-05-11T05:00:00"),
    dayTypeOverride: "auto",
    restMinutes: 30,
    restRange: {
      start: new Date("2024-05-10T20:00:00"),
      end: new Date("2024-05-10T20:30:00"),
    },
  });

  group("Prueba manual: descanso antes de 21:00");
  log("Totales (minutos):", beforeTwentyOne.totals);
  log(
    "Horas nocturnas esperadas (8.00 h):",
    toHours(beforeTwentyOne.totals.rn + beforeTwentyOne.totals.hen).toFixed(2)
  );
  log(
    "Horas totales esperadas (10.50 h):",
    toHours(
      beforeTwentyOne.totals.ordinary +
        beforeTwentyOne.totals.rn +
        beforeTwentyOne.totals.hed +
        beforeTwentyOne.totals.hedf +
        beforeTwentyOne.totals.hen
    ).toFixed(2)
  );
  groupEnd();

  const splitNight = calculateShift({
    start: new Date("2024-03-03T19:00:00"),
    end: new Date("2024-03-04T05:00:00"),
    dayTypeOverride: "auto",
    restMinutes: 60,
    restRange: {
      start: new Date("2024-03-03T22:00:00"),
      end: new Date("2024-03-03T23:00:00"),
    },
  });

  group("Prueba manual: totales diarios con descanso");
  log(
    "Totales domingo (h):",
    toHours(sumMinutes(splitNight.minutesByDay["2024-03-03"])).toFixed(2)
  );
  log(
    "Totales lunes (h):",
    toHours(sumMinutes(splitNight.minutesByDay["2024-03-04"])).toFixed(2)
  );
  log("Detalle por día (minutos):", splitNight.minutesByDay);
  groupEnd();
}

updateFilters();
updateTable();
updateSummary();

logManualExamples();

// Pruebas manuales sugeridas:
// 1. Domingo 19:00 a lunes 05:00 con descanso de 60 minutos entre 22:00 y 23:00.
//    Confirmar que el descanso solo afecta el tramo indicado y que los totales diarios
//    coinciden con las expectativas.
// 2. Viernes 18:00 a sábado 05:00 con descanso de 30 minutos antes de las 21:00 para
//    verificar que las horas nocturnas posteriores se mantienen.
// 3. Registrar una jornada que inicie el domingo y termine el lunes (por ejemplo, 22:00 a 06:00)
//    y verificar que, al filtrar por semana ISO, cada semana muestre únicamente las horas
//    correspondientes a sus días.

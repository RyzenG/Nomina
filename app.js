const form = document.getElementById("shift-form");
const errorsEl = document.getElementById("form-errors");
const tableBody = document.getElementById("results-body");
const resetButton = document.getElementById("reset");
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

  const startRaw = form.start.value;
  const endRaw = form.end.value;
  const dayType = form["day-type"].value;
  const restRaw = form.rest.value;

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

  const calculation = calculateShift({
    start: startDate,
    end: endDate,
    dayTypeOverride: dayType,
    restMinutes,
  });

  records.push(calculation);
  updateTable();
  updateSummary();
  form.reset();
});

resetButton.addEventListener("click", () => {
  records.length = 0;
  updateTable();
  updateSummary();
  form.reset();
  errorsEl.textContent = "";
});

function calculateShift({ start, end, dayTypeOverride, restMinutes }) {
  let segments = splitIntoSegments(start, end);
  if (restMinutes > 0) {
    segments = applyRestToSegments(segments, restMinutes);
  }

  const dayOrdinaryBudget = new Map();
  const totals = {
    ordinaryMinutes: 0,
    rnMinutes: 0,
    hedMinutes: 0,
    hedfMinutes: 0,
    henMinutes: 0,
  };

  for (const segment of segments) {
    const minutes = differenceInMinutes(segment.start, segment.end);
    if (minutes <= 0) continue;

    const dayKey = segment.start.toISOString().slice(0, 10);
    const dayType = resolveDayType(segment.start, dayTypeOverride);
    const isDiurnal = isDiurnalSegment(segment);

    if (!dayOrdinaryBudget.has(dayKey)) {
      dayOrdinaryBudget.set(dayKey, 480); // 8 horas diarias estándar.
    }

    if (dayType === "ordinario") {
      const budget = dayOrdinaryBudget.get(dayKey);
      const usable = Math.min(minutes, budget);
      const remaining = minutes - usable;

      if (isDiurnal) {
        totals.ordinaryMinutes += usable;
        if (remaining > 0) {
          totals.hedMinutes += remaining;
        }
      } else {
        totals.rnMinutes += usable;
        if (remaining > 0) {
          totals.henMinutes += remaining;
        }
      }

      dayOrdinaryBudget.set(dayKey, Math.max(0, budget - usable));
    } else {
      // Para jornadas dominicales o festivas tratamos todas las horas diurnas como HEDF
      // y las nocturnas como HEN (recargo nocturno festivo/dom.).
      if (isDiurnal) {
        totals.hedfMinutes += minutes;
      } else {
        totals.henMinutes += minutes;
      }
    }
  }

  const hours = {
    rn: toHours(totals.rnMinutes),
    hed: toHours(totals.hedMinutes),
    hedf: toHours(totals.hedfMinutes),
    hen: toHours(totals.henMinutes),
    ordinary: toHours(totals.ordinaryMinutes),
  };

  return {
    start,
    end,
    dayType: resolveDayType(start, dayTypeOverride, true),
    hours,
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

function applyRestToSegments(segments, restMinutes) {
  let remaining = restMinutes;
  const adjusted = segments.map((segment) => ({
    start: new Date(segment.start),
    end: new Date(segment.end),
  }));

  for (let i = adjusted.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const segment = adjusted[i];
    const duration = differenceInMinutes(segment.start, segment.end);
    const deduction = Math.min(duration, remaining);
    segment.end = new Date(segment.end.getTime() - deduction * 60000);
    remaining -= deduction;

    if (segment.end <= segment.start) {
      adjusted.splice(i, 1);
    }
  }

  return adjusted;
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

function formatDateTime(date) {
  return date.toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function updateTable() {
  tableBody.innerHTML = "";

  if (records.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.className = "empty";
    cell.textContent = "No hay jornadas registradas.";
    row.append(cell);
    tableBody.append(row);
    return;
  }

  records.forEach((record, index) => {
    const row = document.createElement("tr");

    const totalHours =
      record.hours.ordinary + record.hours.rn + record.hours.hed + record.hours.hedf + record.hours.hen;

    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${formatDateTime(record.start)}</td>
      <td>${formatDateTime(record.end)}</td>
      <td>${record.dayType}</td>
      <td>${record.hours.rn.toFixed(2)}</td>
      <td>${record.hours.hed.toFixed(2)}</td>
      <td>${record.hours.hedf.toFixed(2)}</td>
      <td>${record.hours.hen.toFixed(2)}</td>
      <td>${totalHours.toFixed(2)}</td>
    `;

    tableBody.append(row);
  });
}

function updateSummary() {
  const totals = records.reduce(
    (acc, record) => {
      acc.rn += record.hours.rn;
      acc.hed += record.hours.hed;
      acc.hedf += record.hours.hedf;
      acc.hen += record.hours.hen;
      acc.ordinary += record.hours.ordinary;
      return acc;
    },
    { rn: 0, hed: 0, hedf: 0, hen: 0, ordinary: 0 }
  );

  const totalHours =
    totals.rn + totals.hed + totals.hedf + totals.hen + totals.ordinary;

  totalsEls.rn.textContent = totals.rn.toFixed(2);
  totalsEls.hed.textContent = totals.hed.toFixed(2);
  totalsEls.hedf.textContent = totals.hedf.toFixed(2);
  totalsEls.hen.textContent = totals.hen.toFixed(2);
  totalsEls.hours.textContent = totalHours.toFixed(2);
}

// Pruebas manuales sugeridas:
// 1. Domingo 19:00 a lunes 05:00 con descanso 0. Las horas de 00:00 a 05:00 deben contarse
//    como recargo nocturno ordinario del lunes (no como dominicales).
// 2. Viernes 18:00 a sábado 05:00 para validar horas diurnas ordinarias, RN y HEN.

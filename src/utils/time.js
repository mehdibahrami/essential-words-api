const config = require('../config');

/** Current instant as an ISO-8601 UTC string with milliseconds. */
function nowIso() {
  return new Date().toISOString();
}

/** The timezone's UTC offset (ms) at the given instant. */
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round the source instant down to whole seconds before differencing.
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** The local calendar Y/M/D of `date` in `timeZone`. */
function localYMD(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/**
 * Start of the local day containing `date` (midnight in `timeZone`), returned as
 * an ISO-8601 UTC string. Mirrors the app's `getStartOfDay` using Calendar.current.
 */
function startOfDay(date = new Date(), timeZone = config.timezone) {
  const { year, month, day } = localYMD(date, timeZone);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const off = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - off).toISOString();
}

/** Start of the next local day. Mirrors the app's `getStartOfNextDay`. */
function startOfNextDay(date = new Date(), timeZone = config.timezone) {
  const today = new Date(startOfDay(date, timeZone));
  // Add 26h then re-snap to a day boundary so DST transitions can't land us
  // back on the same local day.
  return startOfDay(new Date(today.getTime() + 26 * 3600 * 1000), timeZone);
}

/** startOfDay(now + intervalDays), as ISO. */
function startOfDayAfterDays(days, date = new Date(), timeZone = config.timezone) {
  const shifted = new Date(date.getTime() + days * 24 * 3600 * 1000);
  return startOfDay(shifted, timeZone);
}

module.exports = { nowIso, startOfDay, startOfNextDay, startOfDayAfterDays, tzOffsetMs, localYMD };

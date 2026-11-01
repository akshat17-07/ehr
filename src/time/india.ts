// Dates as the hospital sees them: India Standard Time (UTC+5:30, no daylight saving).
// The servers run in UTC, so "today" must be worked out here, not with new Date().toISOString().

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The date in India, YYYY-MM-DD. */
export const indiaDate = (at: Date = new Date()): string => dateFormat.format(at);

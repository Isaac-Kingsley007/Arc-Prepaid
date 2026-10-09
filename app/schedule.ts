export type ScheduleInput = {
  payee: string; label: string; amount: string; tip: string;
  startDate: string; startTime: string; interval: string;
  cadence: "day" | "week" | "month"; ending: "count" | "date";
  count: string; endDate: string;
};
export const initialInput: ScheduleInput = {
  payee: "", label: "", amount: "", tip: "0", startDate: "", startTime: "09:00",
  interval: "1", cadence: "month", ending: "count", count: "6", endDate: "",
};
export function units(value: string): bigint | null {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, "0"));
}
export function formatUSDC(value: bigint): string {
  const whole = value / BigInt(1000000);
  const fraction = (value % BigInt(1000000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
}
export function buildSchedule(input: ScheduleInput): { dates: Date[]; error?: string } {
  if (!input.startDate) return { dates: [] };
  const start = new Date(`${input.startDate}T${input.startTime}`);
  if (!Number.isFinite(start.getTime())) return { dates: [], error: "Choose a valid start date and time." };
  const interval = Number(input.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return { dates: [], error: "The interval must be a whole number between 1 and 365." };
  const count = Number(input.count);
  if (input.ending === "count" && (!Number.isInteger(count) || count < 1 || count > 50)) return { dates: [], error: "Choose between 1 and 50 payments." };
  const end = new Date(`${input.endDate}T23:59:59`);
  if (input.ending === "date" && (!input.endDate || !Number.isFinite(end.getTime()) || end < start)) return { dates: [], error: "Choose an end date on or after the first payment." };
  const dates: Date[] = [];
  for (let index = 0; index <= 50; index++) {
    if (input.ending === "count" && index >= count) break;
    const date = new Date(start);
    if (input.cadence === "month") {
      // Keep the original day as the anchor after shorter months.
      date.setDate(1);
      date.setMonth(start.getMonth() + index * interval);
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(start.getDate(), lastDay));
    } else date.setDate(start.getDate() + index * interval * (input.cadence === "week" ? 7 : 1));
    if (!Number.isFinite(date.getTime())) return { dates: [], error: "This schedule extends beyond a supported date." };
    if (input.ending === "date" && date > end) break;
    if (index === 50) return { dates: [], error: "This range contains more than 50 payments. Shorten it or increase the interval." };
    dates.push(date);
  }
  return { dates };
}
export function validateInput(input: ScheduleInput, now = new Date()): Partial<Record<keyof ScheduleInput | "schedule", string>> {
  const errors: Partial<Record<keyof ScheduleInput | "schedule", string>> = {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payee.trim()) || /^0x0{40}$/i.test(input.payee.trim())) errors.payee = "Enter a non-zero, 42-character wallet address starting with 0x.";
  const amount = units(input.amount);
  if (amount === null || amount <= BigInt(0)) errors.amount = "Enter an amount above zero, with up to 6 decimal places.";
  if (units(input.tip || "0") === null) errors.tip = "Enter zero or a positive tip, with up to 6 decimal places.";
  const schedule = buildSchedule(input);
  if (schedule.error) errors.schedule = schedule.error;
  else if (!schedule.dates.length) errors.startDate = "Choose the first payment date.";
  else if (schedule.dates[0] <= now) errors.startDate = "The first payment must be in the future.";
  return errors;
}

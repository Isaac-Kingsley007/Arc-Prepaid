import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSchedule, formatUSDC, initialInput, units, validateInput } from "./schedule";

const input = { ...initialInput, payee: "0x1111111111111111111111111111111111111111", amount: "25.123456", startDate: "2028-01-31", count: "3" };
const dayKeys = (dates: Date[]) => dates.map((date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()]);

test("monthly payments keep their original day across leap and short months", () => {
  assert.deepEqual(dayKeys(buildSchedule(input).dates), [[2028, 1, 31], [2028, 2, 29], [2028, 3, 31]]);
  assert.deepEqual(dayKeys(buildSchedule({ ...input, startDate: "2027-01-31" }).dates), [[2027, 1, 31], [2027, 2, 28], [2027, 3, 31]]);
});
test("a date range includes payments on the end date without adding a later payment", () => {
  const result = buildSchedule({ ...input, cadence: "week", interval: "2", ending: "date", startDate: "2028-01-01", endDate: "2028-01-29" });
  assert.deepEqual(dayKeys(result.dates), [[2028, 1, 1], [2028, 1, 15], [2028, 1, 29]]);
  assert.ok(buildSchedule({ ...input, ending: "date", endDate: "2027-01-01" }).error);
});
test("schedules stop at fifty payments and reject longer date ranges", () => {
  assert.equal(buildSchedule({ ...input, count: "50" }).dates.length, 50);
  assert.ok(buildSchedule({ ...input, count: "51" }).error);
  assert.ok(buildSchedule({ ...input, ending: "date", cadence: "day", endDate: "2028-04-01" }).error);
  assert.ok(buildSchedule({ ...input, interval: "1.5" }).error);
});
test("USDC totals preserve all six decimal places without floating point rounding", () => {
  assert.equal(formatUSDC((units("25.123456")! + units("0.000001")!) * BigInt(3)), "75.370371");
  assert.equal(formatUSDC(units("1000")!), "1,000.00");
  assert.equal(units("1.0000001"), null);
  assert.equal(units("-1"), null);
});
test("review rejects missing addresses, zero amounts, invalid tips, and past dates", () => {
  assert.deepEqual(validateInput(input, new Date("2027-01-01T09:00")), {});
  assert.deepEqual(validateInput({ ...input, tip: "" }, new Date("2027-01-01T09:00")), {});
  const errors = validateInput({ ...input, payee: "0x0000000000000000000000000000000000000000", amount: "0", tip: "-1", startDate: "2020-01-01" });
  assert.ok(errors.payee && errors.amount && errors.tip && errors.startDate);
  assert.ok(validateInput(initialInput).startDate);
});

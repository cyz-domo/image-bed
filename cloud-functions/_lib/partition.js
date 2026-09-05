// 分区规则：images/<分区名>/年/月/文件；images/年/月/文件 属于默认分区
// 分区名：1-32 位，中文/字母/数字/下划线/连字符，且不能是纯 4 位数字（与年份段冲突）
export const PARTITION_NAME = /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,31}$/u;

export function validPartition(name) {
  return typeof name === "string" && PARTITION_NAME.test(name) && !/^\d{4}$/.test(name);
}

export function partitionOf(path) {
  const match = String(path || "").match(/^images\/([^/]+)\/\d{4}\/\d{2}\//);
  if (!match) return "";
  return /^\d{4}$/.test(match[1]) ? "" : match[1];
}

// Intentionally bad code to test style-guide review.
// This file violates multiple rules from STYLE_GUIDE.md.

function calculate_total_price(items: number[]): number {
    // 4-space indentation violates the 2-space rule.
    let total = 0;
    for (const item of items) {
        total += item;
    }
    return total;
}

function BAD_CONSTANT_NAME() {
  return 42;
}

// Snake_case function name violates camelCase rule.
function get_user_name() {
  return "test";
}

// Unhandled promise.
function fetchData() {
  fetch("https://example.com/data");
}

export { calculate_total_price, BAD_CONSTANT_NAME, get_user_name, fetchData };

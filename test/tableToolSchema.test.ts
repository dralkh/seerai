import { assert } from "chai";
import { TableParamsSchema } from "../src/modules/chat/tools/schemas";

describe("table tool schema", function () {
  it("accepts complete_generation with PDF discovery and read options", function () {
    const parsed = TableParamsSchema.parse({
      action: "complete_generation",
      table_id: "table_1",
      column_id: "col_1",
      item_ids: [1, 2],
      ensure_pdfs: true,
      include_data: true,
    });

    assert.equal(parsed.action, "complete_generation");
    assert.equal(parsed.table_id, "table_1");
    assert.deepEqual(parsed.item_ids, [1, 2]);
  });

  it("keeps generate and read actions valid", function () {
    assert.equal(
      TableParamsSchema.parse({
        action: "generate",
        table_id: "table_1",
      }).action,
      "generate",
    );
    assert.equal(
      TableParamsSchema.parse({
        action: "read",
        table_id: "table_1",
        include_data: true,
      }).action,
      "read",
    );
  });
});

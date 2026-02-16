import { booleanSearch } from "./searchUtils";

function test() {
  const targets = [
    "Diabetes",
    "Exercise",
    "Heart Attack",
    "Myocardial Infarction",
    "Aspirin",
    "Prevention",
  ];

  const cases = [
    {
      query: "Diabetes AND Exercise",
      expected: true,
      targets: ["Diabetes", "Exercise"],
    },
    { query: "Diabetes AND Exercise", expected: false, targets: ["Diabetes"] },
    {
      query: "Heart Attack OR Myocardial Infarction",
      expected: true,
      targets: ["Heart Attack"],
    },
    // Implicit Phrase Test: "Heart Attack" should be treated as a phrase
    { query: "Heart Attack", expected: true, targets: ["Heart Attack"] },
    { query: "Heart Attack", expected: false, targets: ["Heart", "Attack"] }, // Should NOT match disjointed words if implicit phrase works
    { query: "Verdict: no", expected: true, targets: ["Verdict: no"] },
    {
      query: "Verdict: no",
      expected: false,
      targets: ["Verdict: maybe", "no significance"],
    }, // The crucial false positive check
    {
      query: "Verdict: no AND full text",
      expected: true,
      targets: ["Verdict: no", "full text"],
    },

    { query: "Diabetes NOT Exercise", expected: true, targets: ["Diabetes"] },
    {
      query: "Diabetes NOT Exercise",
      expected: false,
      targets: ["Diabetes", "Exercise"],
    },
    {
      query: "(Diabetes OR Obesity) AND Exercise",
      expected: true,
      targets: ["Diabetes", "Exercise"],
    },
    {
      query: "(Diabetes OR Obesity) AND Exercise",
      expected: true,
      targets: ["Obesity", "Exercise"],
    },
    {
      query: "(Diabetes OR Obesity) AND Exercise",
      expected: false,
      targets: ["Diabetes"],
    },
    {
      query: "Aspirin AND Prevention NOT Myocardial",
      expected: true,
      targets: ["Aspirin", "Prevention"],
    },
    {
      query: "Aspirin AND Prevention NOT Myocardial",
      expected: false,
      targets: ["Aspirin", "Prevention", "Myocardial"],
    },
    {
      query: '"Heart Attack" AND Aspirin',
      expected: true,
      targets: ["Heart Attack", "Aspirin"],
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const result = booleanSearch(c.query, c.targets);
    if (result === c.expected) {
      console.log(`PASS: "${c.query}" -> ${result}`);
      passed++;
    } else {
      console.error(
        `FAIL: "${c.query}" | targets: [${c.targets.join(", ")}] | expected: ${c.expected} | got: ${result}`,
      );
    }
  }
  console.log(`\nPassed ${passed}/${cases.length} cases.`);
}

test();

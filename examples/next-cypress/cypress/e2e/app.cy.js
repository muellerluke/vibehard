import { uses } from "vibehard/cypress";

import { appShell } from "./uses.js";

it("home page prices, counts, and saves a note", () => {
  uses([...appShell, 'src/app/actions.ts#saveNote', 'src/app/counter/Counter.tsx#Counter', 'src/app/page.tsx#HomePage', 'src/lib/notes.ts#normalizeNote', 'src/lib/pricing.ts#formatPrice']);
  cy.visit("/?cents=2500");
  cy.get('[data-testid="total"]').should("have.text", "$25.00");
  cy.get('[data-testid="add"]').click();
  cy.get('[data-testid="note"]').should("have.text", "CLICK 1");
});

it("price api applies a discount", () => {
  uses(['src/app/api/price/route.ts#GET', 'src/lib/pricing.ts#applyDiscount', 'src/lib/pricing.ts#formatPrice']);
  cy.request("/api/price?cents=10000&discount=25")
    .its("body")
    .should("deep.equal", { cents: 7500, formatted: "$75.00" });
});

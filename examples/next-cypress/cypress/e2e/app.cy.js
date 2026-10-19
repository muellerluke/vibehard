it("home page prices, counts, and saves a note", () => {
  cy.visit("/?cents=2500");
  cy.get('[data-testid="total"]').should("have.text", "$25.00");
  cy.get('[data-testid="add"]').click();
  cy.get('[data-testid="note"]').should("have.text", "CLICK 1");
});

it("price api applies a discount", () => {
  cy.request("/api/price?cents=10000&discount=25")
    .its("body")
    .should("deep.equal", { cents: 7500, formatted: "$75.00" });
});

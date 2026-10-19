"use client";

import { useState } from "react";

import { formatPrice } from "../../lib/pricing";
import { saveNote } from "../actions";

export default function Counter() {
  const [count, setCount] = useState(0);
  const [note, setNote] = useState("");
  return (
    <div>
      <button
        data-testid="add"
        onClick={async () => {
          const next = count + 1;
          setCount(next);
          const saved = await saveNote(`click ${next}`);
          setNote(saved.note);
        }}
      >
        Add item ({formatPrice(count * 100)})
      </button>
      <p data-testid="note">{note}</p>
    </div>
  );
}

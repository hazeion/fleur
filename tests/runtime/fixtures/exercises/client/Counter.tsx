import { defineIsland } from "fleur/client";
import { schema } from "fleur/schema";
import { useState } from "preact/hooks";
export const Counter = defineIsland({
  props: schema.object({ name: schema.string() }),
  component: ({ name }) => {
    const [count, setCount] = useState(0);
    return <button type="button" onClick={() => setCount(value => value + 1)}>{name}: {count}</button>;
  },
});

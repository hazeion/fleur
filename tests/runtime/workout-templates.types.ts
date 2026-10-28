// Inferred contract fixtures for the workout template slice (#31). Checked with tests/runtime/tsconfig.json
// against the fixture's own contracts and tables; the generated reference check covers contracts.types.ts.
import { schema, type Input, type Output } from "../../src/schema";
import { useMutation } from "../../src/client";
import type { WriteDb } from "../../src/database";
import { listTemplates, updateTemplate } from "./fixtures/workouts/shared/contracts";
import { templateEntries } from "./fixtures/workouts/server/workouts";
const id = schema.uuid().parse("550e8400-e29b-41d4-a716-446655440000");
function templateTypes(db: WriteDb) {
  const save: Input<typeof updateTemplate> = { id, expectedVersion: 1, name: "Legs", entries: [{ exerciseId: id, targetSets: 3, targetRepetitions: 5 }] };
  // @ts-expect-error A template save carries its expected aggregate version.
  const unversioned: Input<typeof updateTemplate> = { id, name: "Legs", entries: save.entries };
  // @ts-expect-error Entry exercises are UUID references, not arbitrary strings.
  const arbitrary: Input<typeof updateTemplate>["entries"][number] = { exerciseId: "squat", targetSets: 3, targetRepetitions: 5 };
  // @ts-expect-error Target counts are numbers, not numeric strings.
  const textual: Input<typeof updateTemplate>["entries"][number] = { exerciseId: id, targetSets: "3", targetRepetitions: 5 };
  const listed = (listing: Output<typeof listTemplates>) => {
    const name: string = listing.templates[0]!.entries[0]!.exerciseName;
    const version: number = listing.templates[0]!.version;
    return [name, version, listing.complete] as const;
  };
  useMutation(updateTemplate).run(save);
  // @ts-expect-error Client input requires the ordered entry list.
  useMutation(updateTemplate).run({ id, expectedVersion: 1, name: "Legs" });
  db.insert(templateEntries, { values: { templateId: id, position: 0, exerciseId: id, targetSets: 3, targetRepetitions: 5 }, returning: ["id"] });
  // @ts-expect-error Entry rows require their parent template reference.
  db.insert(templateEntries, { values: { position: 0, exerciseId: id, targetSets: 3, targetRepetitions: 5 }, returning: ["id"] });
  void [unversioned, arbitrary, textual, listed];
}
void templateTypes;

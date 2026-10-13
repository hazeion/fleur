import { expect, test } from 'bun:test';
import { admit } from './broker';
const session={operation:'compat.query',token:'probe-query'} as const;
const request = {kind:'broker-request',operation:'compat.query',token:'probe-query',action:'readExercise',input:{id:1}};
test('registered requests reject additional SQL, URL, path, setup and authority fields', () => {
  for (const field of ['sql','url','path','shell','setup','transaction','operationToken']) {
    expect(() => admit({...request,[field]:'forbidden'},session)).toThrow();
  }
});
test('operation identity cannot borrow another token or use nested and cross-operation actions', () => {
  for (const patch of [{token:'probe-mutation'},{operation:'compat.mutation'},{action:'begin'},{action:'readRetrieval'},{action:'setup'}]) expect(() => admit({...request,...patch},session)).toThrow();
  expect(() => admit({...request,input:{id:1,sql:'SELECT 1'}},session)).toThrow();
});

test('query channel cannot borrow a valid registered mutation operation', () => {
  const mutation={kind:'broker-request',operation:'compat.mutation',token:'probe-mutation',action:'saveExercise',input:{id:1,expectedVersion:1,name:'Stolen'}};
  expect(() => admit(mutation,session)).toThrow();
});

// Disposable request sender. The runtime probe separately proves restricted execution.
console.log(JSON.stringify({kind:'broker-request',operation:'compat.mutation',token:'probe-mutation',action:'saveExercise',input:{id:1,expectedVersion:1,name:'Killed writer',delayMs:3000}}));
await new Promise(() => setInterval(() => {},1000));
export {};

// Web Share Target inbox. Shared File blobs are stored briefly in local
// IndexedDB by the service worker and removed immediately after import.
// No source media ever passes through an app backend.
const DB='halalframe-shared-media-v1',STORE='inbox';
export const INBOX_DB=DB;
function dbOpen(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB,1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE);};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('Cannot open shared-media inbox'));
});}
export async function takeSharedFile(id){
  if(!id||id.length>100)return null;
  const db=await dbOpen();
  try{
    const record=await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),req=store.get(id);
      let item=null;
      req.onsuccess=()=>{item=req.result||null;if(item)store.delete(id);};
      tx.oncomplete=()=>resolve(item);
      tx.onerror=()=>reject(tx.error||new Error('Shared import failed'));
      tx.onabort=()=>reject(tx.error||new Error('Shared import aborted'));
    });
    if(!record)return null;
    const type=record.type||record.blob?.type||'application/octet-stream';
    return new File([record.blob],record.name||'shared-media', {type,lastModified:record.lastModified||Date.now()});
  }finally{db.close();}
}

/** Choose the newest mounted snapshot for each session/project; never compare titles. */
export function supersededOverviews(rows:{session:string;project:string;createdAt:number}[]):boolean[]{
 const latest=new Map<string,number>();
 rows.forEach((row,index)=>{
  if(!row.session||!row.project)return;
  const key=JSON.stringify([row.session,row.project]),previous=latest.get(key);
  if(previous===undefined||row.createdAt>=rows[previous]!.createdAt)latest.set(key,index);
 });
 return rows.map((row,index)=>!!row.session&&!!row.project&&latest.get(JSON.stringify([row.session,row.project]))!==index);
}

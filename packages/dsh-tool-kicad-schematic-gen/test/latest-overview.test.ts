import {test} from 'node:test'
import assert from 'node:assert/strict'
import {supersededOverviews} from '../src/client/latest-overview.ts'

test('only newest same-session project card stays visible regardless of mount order',()=>{
 const row=(session:string,project:string,createdAt:number)=>({session,project,createdAt});
 assert.deepEqual(supersededOverviews([row('a','p',20),row('a','p',10),row('b','p',30),row('a','q',40)]),[false,true,false,false]);
 assert.deepEqual(supersededOverviews([row('a','p',10),row('a','p',20)]),[true,false]);
 assert.deepEqual(supersededOverviews([row('a','p',10)]),[false]);
 assert.deepEqual(supersededOverviews([row('','p',10),row('','p',20),row('a','',10)]),[false,false,false]);
})

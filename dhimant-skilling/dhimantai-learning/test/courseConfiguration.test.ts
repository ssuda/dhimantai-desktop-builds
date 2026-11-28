import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {courseConfiguration} from '../src/courseConfiguration';
import {authoredConfiguration} from './authoredConfiguration';
const fresh=()=>{const c=authoredConfiguration('A newly published course');c.recipe={language:'javascript',services:['redis','postgres'],labs:true};c.notebooks=[{id:'chapter-new',name:'01-live-services.ipynb'}];return c;};
test('a new title and its tools, notebooks and ports need no desktop registration',()=>{
 const c=fresh();c.ports=[{port:3000,protocol:'tcp'}];assert.equal(courseConfiguration(c,c.title),c);
 for(const corrupt of [(x:any)=>x.ports=[{port:22,protocol:'tcp'}],(x:any)=>x.notebooks[0].name='../../escape.ipynb',
 (x:any)=>x.instructor_terminal={kind:'db2',auto_open:'yes'},(x:any)=>x.instructor_terminal={kind:'postgres',auto_open:true},
 (x:any)=>x.instructor_terminal={kind:'arbitrary',auto_open:true},(x:any)=>x.compute.default={nodes:1,gpusPerNode:1,totalGpus:8},(x:any)=>x.recipe.language='arbitrary',
 (x:any)=>x.datasets.bad={sql:'altered',sha256:'0'.repeat(64),about:{}}]) {const value=fresh();corrupt(value);assert.throws(()=>courseConfiguration(value,value.title));}
});
test('configuration scopes account and environment, refreshes without a release, and refuses an account switch during fetch',async()=>{
 const filename=resolve(__dirname,'../src/courseWorkspace.js'),exports:any={};const nativeRequire=createRequire(filename);
 const stubs=new Set(['vscode','./courseAppPreview','./podman','./courseEngine','./courseRecovery','./courseDebug','./courseReadiness','./courseTerminal','./colab','./colabNotebooks','./notebookKernelPicker']);
 runInNewContext(readFileSync(filename,'utf8'),{exports,process,require:(name:string)=>stubs.has(name)?{}:nativeRequire(name)});
 const workspaces=Object.create(exports.CourseWorkspaces.prototype);workspaces.configurations=new Map();
 let account='one',environment='staging',calls=0;
 workspaces.checkAccount=async(s:any)=>{if(s.account!==account||s.environment!==environment)throw new Error('scope changed');};
 workspaces.downloadRuntime=async()=>{calls++;return {configuration:fresh(),runtime:null};};
 const scope=()=>({course:'A newly published course',account,environment});
 await workspaces.configuration(scope());await workspaces.configuration(scope());assert.equal(calls,1);
 await workspaces.configuration(scope(),true);assert.equal(calls,2);
 account='two';await workspaces.configuration(scope());assert.equal(calls,3);
 environment='production';await workspaces.configuration(scope());assert.equal(calls,4);
 workspaces.downloadRuntime=async()=>{account='three';return {configuration:fresh(),runtime:null};};
 await assert.rejects(workspaces.configuration(scope(),true),/scope changed/);assert.equal(workspaces.configurations.size,3);
});

import {NotebookCells, CellOptions} from './notebookCells';
import {RUN_TIMEOUT_MS, Toolchains} from './localRunner';
import type {CourseEngine} from './courseEngine';

/** Compatibility wrapper; Instructor now uses the same streaming session as other notebook cells. */
export class TutorPython {
  private cells:NotebookCells;
  constructor(tools:()=>Toolchains,engine?:()=>Promise<CourseEngine|undefined>,timeout=RUN_TIMEOUT_MS){
    this.cells=new NotebookCells(tools,engine,undefined,timeout);
  }
  run(source:string,stdin:string,options:CellOptions={}){return this.cells.run('python',source,stdin,options);}
  restart(){this.cells.restart();}
}

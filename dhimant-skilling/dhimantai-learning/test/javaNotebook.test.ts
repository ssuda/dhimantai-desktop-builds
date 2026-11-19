import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {NotebookCells} from '../src/notebookCells';

const image = process.env.DHIMANTAI_JAVA_TEST_IMAGE;
const hasJava = () => {try {execFileSync('javac',['-version'],{stdio:'ignore'});return true;} catch {return false;}};
const body = 'public static void main(String[] args) { System.out.println("Total = " + (10 + 5)); }';
const cases = [
  {name:'reported class', file:'Sum.java', source:`public class Sum { ${body} }`},
  {name:'existing Main', file:'Main.java', source:`public class Main { ${body} }`},
  {name:'live staging example', file:'ForEachTotal.java', source:`public class ForEachTotal {
    public static void main(String[] args) {
        int total = 0;
        for (int n : new int[] {1, 2, 3, 4, 5}) total += n;
        System.out.println("Total = " + total);
    }
}`},
  {name:'comments and literals', file:'Real.java', source:`// public class Fake { }
/* public class Wrong { public static void main(String[] args) {} } */
public final class Real {
    String decoy = "public class AlsoWrong { }";
    String text = """
        public class NotCode { }
        """;
    ${body}
}`},
  {name:'nested public class', file:'Outer.java', source:`class Helper { public static class Nested {} }
public class Outer { ${body} }`},
  {name:'named constructor and references', file:'Sum.java', source:`public class Sum {
    final int n;
    Sum(int n) {this.n = n;}
    public static void main(String[] args) {System.out.println("Total = " + new Sum(15).n);}
}`},
  {name:'helper before entry class', file:'Main.java', source:`class Sum { int value() {return 15;} }
public class Main { public static void main(String[] args) {System.out.println("Total = " + new Sum().value());} }`},
  {name:'package', file:'Packaged.java', source:`package lesson.examples;
public class Packaged { ${body} }`},
  {name:'non-public entry', file:'Runner.java', source:`class Helper {} class Runner { ${body} }`},
  {name:'public helper owns filename', file:'Helper.java', source:`public class Helper {} class Runner { ${body} }`},
  {name:'record', file:'Total.java', source:`public record Total(int value) { ${body} }`},
  {name:'dollar and Unicode identifiers', file:'Σum$Demo.java', source:`public class Σum$Demo { ${body} }`},
];

test('Java notebook runs declared classes unchanged and preserves real compiler failures',
  {skip:!image && !hasJava(),timeout:120000},async()=>{
    const cells = new NotebookCells(()=>({}),undefined,undefined,15000,image ? {
      target:'Java regression container',
      start:async()=>spawn('podman',['run','--rm','-i','--read-only','--network=none',
        '--tmpfs','/tmp:rw,exec','--tmpfs','/workspace:rw,exec','--workdir','/workspace',
        '-v',resolve(__dirname,'../../media/course')+':/opt/current:ro',
        '--entrypoint','python',image,'-u','/opt/current/cells.py'])
    }:undefined);
    try {
      for (const item of cases) {
        const run = await cells.run('java',item.source);
        assert.equal(run.exit_code,0,item.name+': '+run.stderr);
        assert.equal(run.stdout,'Total = 15\n',item.name);
        const saved = await cells.run('python',`import hashlib\nfrom pathlib import Path\nprint(hashlib.sha256(Path(${JSON.stringify(item.file)}).read_bytes()).hexdigest())`);
        assert.equal(saved.stdout.trim(),createHash('sha256').update(item.source).digest('hex'),item.name+' source unchanged');
      }
      const broken = await cells.run('java','public class Sum { public static void main(String[] args) { BROKEN } }');
      assert.equal(broken.status,'compile_error');
      assert.equal(broken.exit_code,1);
      assert.match(broken.stderr,/Sum\.java/);
      assert.equal(broken.stdout,'','failed compilation must not run a stale Sum.class');
      const noMain = await cells.run('java','public class WithoutMain {}');
      assert.equal(noMain.status,'exited');
      assert.equal(noMain.exit_code,1);
      assert.match(noMain.stderr,/Main method not found/);
      const duplicate = await cells.run('java',`public class First {} public class Second { ${body} }`);
      assert.equal(duplicate.exit_code,1);
      assert.match(duplicate.stderr,/Second.java/);
      const inputs = await cells.run('java',`public class Inputs {
        public static void main(String[] args) {System.out.println(args[0] + new java.util.Scanner(System.in).nextInt());}
      }`,'15\n',{argv:['Total = ']});
      assert.equal(inputs.exit_code,0,inputs.stderr);
      assert.equal(inputs.stdout,'Total = 15\n');
    } finally {await cells.close();}
  });

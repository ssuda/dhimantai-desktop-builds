"""Exercise cells against a course image with all seven toolchains, IPython, matplotlib, zsh and PostgreSQL.
Usage: python3 scripts/check-notebook-cells.py IMAGE
No shared services or real learner notebooks are used.
"""
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import uuid

source=Path(__file__).resolve().parents[1]/'media/course'
name='notebook-check-'+uuid.uuid4().hex[:10]
process=subprocess.Popen(['podman','run','--rm','--name',name,'--network=none','--workdir=/tmp',
    '-v',str(source)+':/opt/current:ro','-i',sys.argv[1],'python','-u','/opt/current/cells.py'],
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
messages=queue.Queue()
def read():
    for line in process.stdout: messages.put(json.loads(line))
threading.Thread(target=read,daemon=True).start()
index=0

def run(language,source,expected=None,**options):
    global index
    index+=1
    stop_after=options.pop('stop_after',None)
    process.stdin.write(json.dumps(dict(action='run',id=str(index),language=language,source=source,**options))+'\n');process.stdin.flush()
    def stop():
        process.stdin.write('{"action":"stop"}\n');process.stdin.flush()
    timer=threading.Timer(stop_after,stop) if stop_after else None
    if timer: timer.start()
    displays=[]
    while True:
        msg=messages.get(timeout=120)
        if msg['kind']=='display': displays.append(msg['data'])
        if msg['kind']=='input':
            process.stdin.write(json.dumps(dict(action='input',id=str(index),value='Asha'))+'\n');process.stdin.flush()
        if msg['kind']=='stream' and options.get('interactive') and 'Enter number' in msg.get('text',''):
            process.stdin.write(json.dumps(dict(action='input',id=str(index),value='42'))+'\n');process.stdin.flush()
        if msg['kind']=='done':
            if timer: timer.cancel()
            result=msg['execution']
            if stop_after: assert result['status']=='cancelled',(language,result)
            else: assert result['exit_code']==0,(language,result)
            if expected is not None: assert expected in result['stdout'],(language,result)
            print('PASS',index,language,flush=True)
            return result,displays
try:
    for language,code in {
        'python':'value=41; print(value+1)',
        'javascript':'console.log(42)',
        'typescript':'const n:number=42;console.log(n)',
        'java':'public class Main { public static void main(String[] a){System.out.println(42);} }',
        'c':'#include <stdio.h>\nint main(){puts("42");}',
        'go':'package main\nimport "fmt"\nfunc main(){fmt.Println(42)}',
        'rust':'fn main(){println!("42");}',
        'bash':'echo 42','zsh':'print 42',
    }.items(): run(language,code,'42')
    run('python','print(value)','41')
    run('python','import subprocess; subprocess.run(["echo","visible child output"],check=True)','visible child output')
    run('python','print(input("Name: "))','Asha',interactive=True)
    run('c','#include <stdio.h>\nint main(){int n;printf("Enter number: ");scanf("%d",&n);printf("value=%d\\n",n);}','value=42',interactive=True)
    run('bash','%%writefile helper.py\nanswer=42','Saved')
    run('python','from helper import answer;print(answer)','42')
    run('python','from IPython.display import display,HTML;display(HTML("<b>cell html</b>"))')
    _,displays=run('python','import matplotlib.pyplot as plt\nplt.plot([1,2,3]);plt.show()')
    assert any('image/png' in d for d in displays),'Plot was not displayed'
    run('sql','CREATE TABLE shared(n int); INSERT INTO shared VALUES (42)')
    run('sql','SELECT n FROM shared','42')
    run('pglab','psql -qc "CREATE TABLE lab_data(n int);INSERT INTO lab_data VALUES(42)"',database='lab')
    run('sql','SELECT n FROM lab_data','42',database='lab')
    run('sql','SELECT pg_sleep(30)',database='lab',stop_after=1)
    run('sql','SELECT n FROM lab_data','42',database='lab')
    run('pglab','pg_ctl -D "$PGDATA" restart -w -m fast >/dev/null',database='lab')
    run('sql','SELECT n FROM lab_data','42',database='lab')
    process.stdin.write('{"action":"close"}\n');process.stdin.flush();process.wait(timeout=30)
    assert process.returncode==0,process.stderr.read()[-1000:]
    print('PASS: all',index,'cell executions; plotting, input, files and database state',flush=True)
except BaseException:
    subprocess.run(['podman','exec',name,'python','-c',
        'from pathlib import Path; [print(str(p)+"\\n"+p.read_text()[-4000:]) for p in Path("/tmp").glob("pg*/server.log")]'])
    raise
finally:
    subprocess.run(['podman','rm','-f','--ignore',name],capture_output=True)

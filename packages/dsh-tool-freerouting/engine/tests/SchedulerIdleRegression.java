import app.freerouting.core.RoutingJob;
import app.freerouting.core.RoutingJobState;
import app.freerouting.management.jobs.RoutingJobScheduler;
import com.sun.management.ThreadMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;

public class SchedulerIdleRegression {
    public static void main(String[] args) throws Exception {
        try {
            RoutingJob job = RoutingJob.class.getDeclaredConstructor().newInstance();
            job.state = RoutingJobState.COMPLETED;
            RoutingJobScheduler scheduler = RoutingJobScheduler.getInstance();
            synchronized (scheduler.jobs) {
                scheduler.jobs.add(job);
            }
            ThreadMXBean bean = (ThreadMXBean) ManagementFactory.getThreadMXBean();
            bean.setThreadCpuTimeEnabled(true);
            bean.setThreadAllocatedMemoryEnabled(true);
            long schedulerId = -1;
            long identifyBy = System.nanoTime() + 2_000_000_000L;
            while (System.nanoTime() < identifyBy && schedulerId < 0) {
                for (ThreadInfo info : bean.dumpAllThreads(false, false)) {
                    if (info.getThreadName().equals("freerouting-job-scheduler")) {
                        schedulerId = info.getThreadId();
                    }
                    for (StackTraceElement frame : info.getStackTrace()) {
                        if (frame.getClassName().equals(RoutingJobScheduler.class.getName())) {
                            schedulerId = info.getThreadId();
                        }
                    }
                }
                Thread.sleep(10);
            }
            if (schedulerId < 0) {
                throw new AssertionError("Scheduler thread not observed");
            }
            Thread.sleep(200);
            long beforeCpu = bean.getThreadCpuTime(schedulerId);
            long beforeBytes = bean.getThreadAllocatedBytes(schedulerId);
            Thread.sleep(1500);
            long cpu = bean.getThreadCpuTime(schedulerId) - beforeCpu;
            long allocated = bean.getThreadAllocatedBytes(schedulerId) - beforeBytes;
            System.out.println("{\"idleCpuMs\":" + cpu / 1_000_000 + ",\"idleAllocatedBytes\":" + allocated + "}");
            if (cpu > 150_000_000L || allocated > 8 * 1024 * 1024L) {
                throw new AssertionError("A finished routing job keeps the scheduler busy and allocating memory");
            }
            System.exit(0);
        } catch (Throwable cause) {
            cause.printStackTrace();
            System.exit(1);
        }
    }
}

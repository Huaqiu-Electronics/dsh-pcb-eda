import app.freerouting.core.BoardFileDetails;
import app.freerouting.core.RoutingJob;
import app.freerouting.core.RoutingJobState;
import app.freerouting.io.FileFormat;
import app.freerouting.management.HeadlessBoardManager;
import app.freerouting.management.jobs.RoutingJobSchedulerActionThread;
import app.freerouting.settings.GlobalSettings;
import app.freerouting.settings.SettingsMerger;
import app.freerouting.settings.sources.DefaultSettings;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

class FinalOutputRegression {
  private static final byte[] EARLIER = "earlier-preview".getBytes(StandardCharsets.UTF_8);

  public static void main(String[] args) throws Exception {
    GlobalSettings settings = new GlobalSettings();
    settings.usageAndDiagnosticData.disableAnalytics = true;
    GlobalSettings.setCurrent(settings);
    Method export = RoutingJobSchedulerActionThread.class.getDeclaredMethod("setJobOutput", RoutingJob.class);
    export.setAccessible(true);
    Method terminal = RoutingJobSchedulerActionThread.class.getDeclaredMethod("assignTerminalState", boolean.class);
    terminal.setAccessible(true);

    RoutingJob failed = job();
    RoutingJobSchedulerActionThread failedWorker = worker(failed);
    boolean exported = (boolean) export.invoke(failedWorker, failed);
    terminal.invoke(failedWorker, exported);
    require(!exported && failed.output == null && failed.state == RoutingJobState.INVALID,
        "failed final export exposed an earlier preview");

    RoutingJob valid = loaded(args[0]);
    RoutingJobSchedulerActionThread validWorker = worker(valid);
    exported = (boolean) export.invoke(validWorker, valid);
    terminal.invoke(validWorker, exported);
    require(exported && valid.state == RoutingJobState.COMPLETED && valid.output != null,
        "valid final export was rejected");
    require(!Arrays.equals(EARLIER, valid.output.getData().readAllBytes()),
        "successful export did not replace the earlier preview");

    RoutingJob expired = job();
    expired.timeoutAt = Instant.now().minusSeconds(1);
    terminal.invoke(worker(expired), true);
    require(expired.state == RoutingJobState.TIMED_OUT, "expired deadline reported completion");

    RoutingJob cancelled = job();
    cancelled.setCancelledByUser(true);
    terminal.invoke(worker(cancelled), false);
    require(cancelled.state == RoutingJobState.CANCELLED, "cancellation was overwritten");

    RoutingJob terminalJob = job();
    terminalJob.state = RoutingJobState.TIMED_OUT;
    terminal.invoke(worker(terminalJob), true);
    require(terminalJob.state == RoutingJobState.TIMED_OUT, "terminal timeout was overwritten");

    for (int attempt = 0; attempt < 3; attempt++) {
      RoutingJob completed = loaded(args[0]);
      RoutingJobSchedulerActionThread action = worker(completed);
      AtomicReference<Throwable> failure = new AtomicReference<>();
      action.setUncaughtExceptionHandler((thread, cause) -> failure.set(cause));
      action.start();
      action.join(10000);
      require(!action.isAlive() && completed.state == RoutingJobState.COMPLETED,
          "disabled-stage job failed to finish: " + completed.state);
      require(failure.get() == null, "worker threw after completion: " + failure.get());
      String monitorName = "freerouting-job-monitor-" + completed.id;
      long deadline = System.nanoTime() + 2_000_000_000L;
      while (System.nanoTime() < deadline && monitorAlive(monitorName)) {
        Thread.sleep(25);
      }
      require(!monitorAlive(monitorName), "completed job leaked its monitor thread");
    }
    System.out.println("Final output, deadline, cancellation and three monitor exits verified");
  }

  private static RoutingJob job() {
    RoutingJob job = new RoutingJob();
    job.state = RoutingJobState.RUNNING;
    job.routerSettings = new SettingsMerger(new DefaultSettings()).merge();
    job.routerSettings.fanout.enabled = false;
    job.routerSettings.setRunRouter(false);
    job.routerSettings.setRunOptimizer(false);
    job.output = new BoardFileDetails();
    job.output.format = FileFormat.SES;
    job.output.setData(EARLIER);
    job.output.format = FileFormat.SES;
    return job;
  }

  private static RoutingJob loaded(String input) throws Exception {
    RoutingJob job = job();
    require(job.setInput(Files.readAllBytes(Path.of(input))), "fixture DSN rejected");
    job.input.setFilename("fixture.dsn");
    HeadlessBoardManager manager = new HeadlessBoardManager(job);
    manager.loadFromSpecctraDsn(job.input.getData(), null, null);
    job.board = manager.getRoutingBoard();
    require(job.board != null, "fixture routing board unavailable");
    return job;
  }

  private static RoutingJobSchedulerActionThread worker(RoutingJob job) {
    RoutingJobSchedulerActionThread worker = new RoutingJobSchedulerActionThread(job);
    job.thread = worker;
    return worker;
  }

  private static boolean monitorAlive(String name) {
    return Thread.getAllStackTraces().keySet().stream().anyMatch(thread -> thread.getName().equals(name));
  }

  private static void require(boolean condition, String message) {
    if (!condition) {
      throw new AssertionError(message);
    }
  }
}

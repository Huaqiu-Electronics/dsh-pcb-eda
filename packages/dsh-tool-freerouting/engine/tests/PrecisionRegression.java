import app.freerouting.board.facade.BasicBoard;
import app.freerouting.board.state.Communication;
import app.freerouting.board.model.structure.FixedState;
import app.freerouting.board.model.structure.Layer;
import app.freerouting.board.model.structure.LayerStructure;
import app.freerouting.board.trace.PolylineTrace;
import app.freerouting.board.model.structure.Unit;
import app.freerouting.datastructures.IdentifierType;
import app.freerouting.datastructures.IndentFileWriter;
import app.freerouting.io.CoordinateTransform;
import app.freerouting.io.specctra.SesWriter;
import app.freerouting.geometry.planar.*;
import app.freerouting.rules.BoardRules;
import app.freerouting.rules.ClearanceMatrix;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;

class PrecisionRegression {
    private static final Method WRITE;
    static {
        try {
            WRITE = SesWriter.class.getDeclaredMethod("writeWire", PolylineTrace.class,
                BasicBoard.class, IdentifierType.class, CoordinateTransform.class, IndentFileWriter.class);
            WRITE.setAccessible(true);
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private static Polyline shortLine(int sign) {
        return new Polyline(new Line[]{
            new Line(new IntPoint(100, sign * 90), new IntPoint(100, sign * 110)),
            new Line(new IntPoint(100, sign * 100), new IntPoint(99, sign * 100 - 1)),
            new Line(new IntPoint(99, sign * 100), new IntPoint(100, sign * 100 - 1))});
    }

    private static String wire(Polyline line, int resolution, double scale) throws Exception {
        LayerStructure layers = new LayerStructure(new Layer[]{new Layer("F.Cu", true), new Layer("B.Cu", true)});
        BoardRules rules = new BoardRules(layers, ClearanceMatrix.getDefaultInstance(layers, 1));
        Communication defaults = new Communication();
        Communication communication = new Communication(Unit.UM, resolution, defaults.specctraParserInfo,
            new CoordinateTransform(1, 0, 0), defaults.idGenerator, defaults.observers);
        BasicBoard board = new BasicBoard(new IntBox(-10000, -10000, 10000, 10000), layers,
            new PolylineShape[0], 0, rules, communication);
        PolylineTrace trace = new PolylineTrace(line, 0, 10, new int[]{1}, 0, 1, 0, FixedState.UNFIXED, board);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (IndentFileWriter file = new IndentFileWriter(bytes)) {
            WRITE.invoke(null, trace, board, new IdentifierType(new String[]{"(", ")", " "}, "\""),
                new CoordinateTransform(scale, 0, 0), file);
        }
        return bytes.toString("UTF-8");
    }

    private static void save(Path directory, String name, Polyline line, int resolution, String endpoint) throws Exception {
        String wire = wire(line, resolution, 1);
        if (!wire.contains(endpoint)) {
            throw new AssertionError(name + ": endpoint lost: " + wire);
        }
        String ses = "(session precision.ses (base_design precision.dsn) (placement (resolution um " + resolution
            + ")) (routes (resolution um " + resolution + ") (library_out) (network_out (net GND " + wire + "))))";
        Files.writeString(directory.resolve(name + ".ses"), ses);
    }

    public static void main(String[] args) throws Exception {
        Path directory = Path.of(args[0]);
        save(directory, "positive-short", shortLine(1), 10, "99.5 99.5");
        save(directory, "negative-short", shortLine(-1), 10, "99.5 -100.5");
        save(directory, "resolution-25", shortLine(1), 25, "99.5 99.5");
        Polyline ordinary = new Polyline(new Point[]{new IntPoint(100, -100), new IntPoint(110, -100)});
        save(directory, "ordinary", ordinary, 10, "110 -100");
        save(directory, "native-grid", ordinary, 1000, "110 -100");
        Polyline exactPoint = new Polyline(new Line[]{
            new Line(new IntPoint(100, 90), new IntPoint(100, 110)),
            new Line(new IntPoint(90, 100), new IntPoint(110, 100)),
            new Line(new IntPoint(90, 90), new IntPoint(110, 110))});
        save(directory, "integer-point", exactPoint, 10, "100 100");
        Polyline rationalPoint = new Polyline(new Line[]{
            new Line(new IntPoint(99, 100), new IntPoint(100, 99)),
            new Line(new IntPoint(99, 99), new IntPoint(100, 100)),
            new Line(new IntPoint(98, 100), new IntPoint(101, 99))});
        save(directory, "rational-point", rationalPoint, 10, "99.5 99.5");
        try {
            wire(shortLine(1), 10, 1000);
            throw new AssertionError("Unrepresentable sub-nanometre trace was accepted");
        } catch (InvocationTargetException error) {
            if (!(error.getCause() instanceof IOException)) {
                throw error;
            }
        }
        System.out.println("Precision writer cases passed; unrepresentable trace rejected");
    }
}

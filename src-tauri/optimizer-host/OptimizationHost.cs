using System.Reflection;
using DotaTel.Processes;

namespace DotaTel.Optimization;

/// <summary>Establishes process-tree ownership before invoking the unchanged optimizer entry point.</summary>
internal static class OptimizationHost
{
    /// <summary>Run the original optimizer with its exact arguments and exit code; fail closed if containment fails.</summary>
    private static async Task<int> Main(string[] args)
    {
        try
        {
            string[] originalArguments = ReadOriginalArguments(args);
            OwnedProcessJob.JoinParent(args[1]);
            Console.WriteLine("BACKTESTENGINE_OPTIMIZER_HOST_READY");
            var bindings = new CandidateBindings(originalArguments);
            MethodInfo entry = typeof(BacktestEngine.Optimizer.Program).GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("The original optimizer entry point is unavailable.");
            var pending = entry.Invoke(null, new object[] { originalArguments }) as Task<int>
                ?? throw new InvalidOperationException("The original optimizer entry point has an unexpected contract.");
            int exitCode = await pending.ConfigureAwait(false);
            bindings.Publish();
            return exitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("BACKTESTENGINE_OPTIMIZER_HOST_ERROR " + error.GetBaseException().Message);
            return 1;
        }
    }

    /// <summary>Remove only the fixed private native job envelope; original CLI arguments retain their exact order and values.</summary>
    private static string[] ReadOriginalArguments(string[] arguments)
    {
        if (arguments.Length != 5 || arguments[0] != "--job" || arguments[2] != "--"
            || arguments[3] != "--config" || !Path.IsPathFullyQualified(arguments[4]))
            throw new ArgumentException("The optimizer requires its exact native parent-job/configuration envelope.");
        return arguments.Skip(3).ToArray();
    }

}
